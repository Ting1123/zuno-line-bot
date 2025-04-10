// Node.js (Express) application code for LINE Bot car detailing booking system
// (All user-facing text is in Traditional Chinese)

// 請先使用 npm 安裝 express 和 @line/bot-sdk
const express = require('express');
const line = require('@line/bot-sdk');

const app = express();

// LINE Messaging API credentials (set in environment variables on Render)
const config = {
    channelSecret: process.env.CHANNEL_SECRET,
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN
};

// Initialize LINE SDK client
const client = new line.Client(config);

// Use LINE middleware for signature validation and parsing request body
app.post('/webhook', line.middleware(config), async (req, res) => {
    try {
        // Handle all incoming events (could be multiple if user sent multiple messages quickly)
        const results = await Promise.all(req.body.events.map(handleEvent));
        res.json(results);
    } catch (err) {
        console.error('Error handling webhook events:', err);
        res.status(500).end();
    }
});

// In-memory data storage for user memory and bookings
const userMemory = {};   // store saved info by userId: { phone, licensePlate, location }
const bookings = {};     // store current booking by userId: { userId, phone, category, subcategory, carType, licensePlate, date, timeSlot, location, note }

// Predefined service categories, subcategories, differences and prices
const serviceCategories = {
    "清潔養護": {
        subs: [
            {
                name: "基礎洗車",
                diff: "基礎洗車：僅清洗車身外部。",
                prices: { small: 500, sedan: 700, suv: 900 }
            },
            {
                name: "高級洗車",
                diff: "高級洗車：包含車內吸塵和車身打蠟。",
                prices: { small: 800, sedan: 1000, suv: 1300 }
            }
        ],
        diff: "基礎洗車：僅清洗車身外部。\n高級洗車：包含車內吸塵和車身打蠟。"
    },
    "拋光美容": {
        subs: [
            {
                name: "打蠟",
                diff: "打蠟：手工塗抹蠟增進車漆光澤。",
                prices: { small: 1500, sedan: 1800, suv: 2200 }
            },
            {
                name: "拋光",
                diff: "拋光：機器拋光去除細微刮痕。",
                prices: { small: 2000, sedan: 2500, suv: 3000 }
            }
        ],
        diff: "打蠟：手工塗抹蠟增進車漆光澤。\n拋光：使用拋光機處理，減少車漆瑕疵。"
    },
    "鍍膜套餐": {
        subs: [
            {
                name: "單層鍍膜",
                diff: "單層鍍膜：一層鍍膜施工。",
                prices: { small: 5000, sedan: 6000, suv: 7000 }
            },
            {
                name: "雙層鍍膜",
                diff: "雙層鍍膜：兩層鍍膜，更持久亮度。",
                prices: { small: 8000, sedan: 9000, suv: 10000 }
            }
        ],
        diff: "單層鍍膜：基礎鍍膜一次。\n雙層鍍膜：重複鍍膜兩次，提升持久度和光澤。"
    },
    "全車玻璃鍍膜+除油膜": {
        subs: [], // no subcategories, single service
        // We provide a price mapping directly on category since no subcategories
        prices: { small: 3000, sedan: 3000, suv: 3500 }
    }
};

// Car type options (in Chinese) mapping to keys for price lookup
const carTypeMap = {
    "小型車": "small",
    "中型車": "sedan",
    "大型車/SUV": "suv"
};

// Session state to track ongoing conversation for each user
const sessionState = {}; 
// sessionState[userId] = {
//    flow: "booking" | "price" | "change",
//    step: string (current step name),
//    data: {} (to accumulate answers),
//    editOriginalUserId: (if editing an existing booking for a given userId, used in change flow refill option)
// }

// Handler for incoming events
async function handleEvent(event) {
    // Ignore non-text message events except specific ones we handle (like postback, follow)
    if (event.type === 'follow') {
        // New user added the bot -> send welcome menu
        const replyMsg = createMainMenuFlex();
        return client.replyMessage(event.replyToken, replyMsg);
    }
    if (event.type === 'message' && event.message.type !== 'text' && event.message.type !== 'location') {
        // If message is not text (or location for location sharing), we do not handle
        return Promise.resolve(null);
    }
    try {
        const userId = event.source.userId;
        // If user is not in sessionState, they are either starting fresh or in between flows
        // Text from user
        if (event.type === 'message' && event.message.type === 'text') {
            const userText = event.message.text;
            // Trim whitespace
            const text = userText.trim();
            // Check if user is currently in a flow
            if (sessionState[userId] && sessionState[userId].flow) {
                // Handle based on current flow and step
                const state = sessionState[userId];
                const flow = state.flow;
                const step = state.step;
                // Shortcut for "back" command
                if (text === "返回上一階段" || text === "返回") {
                    return handleBackAction(event.replyToken, userId);
                }
                if (flow === "booking") {
                    return handleBookingFlow(event.replyToken, userId, text);
                } else if (flow === "price") {
                    return handlePriceFlow(event.replyToken, userId, text);
                } else if (flow === "change") {
                    return handleChangeFlow(event.replyToken, userId, text);
                }
            } else {
                // No active flow, interpret top-level commands
                if (text === "我要預約") {
                    // Start booking flow
                    sessionState[userId] = { flow: "booking", step: "category", data: {} };
                    // If user has previous memory, we will utilize it later in flow
                    // Present category selection menu
                    const msg = createCategoryQuickReply("booking");
                    return client.replyMessage(event.replyToken, msg);
                } else if (text === "查詢價格") {
                    // Start price inquiry flow
                    sessionState[userId] = { flow: "price", step: "category", data: {} };
                    const msg = createCategoryQuickReply("price");
                    return client.replyMessage(event.replyToken, msg);
                } else if (text === "更改預約") {
                    // Start change booking flow
                    sessionState[userId] = { flow: "change", step: "verify", data: {} };
                    // If this user has an existing booking, we can skip phone input
                    if (bookings[userId]) {
                        // Found booking by userId
                        sessionState[userId].data.foundBooking = bookings[userId];
                        sessionState[userId].step = "options";
                        // Show modify options directly
                        const msg = createChangeOptionsQuickReply();
                        return client.replyMessage(event.replyToken, msg);
                    } else {
                        // Ask for phone number to find booking
                        const askPhoneMsg = {
                            type: "text",
                            text: "請輸入您預約時留下的聯絡電話：",
                            quickReply: {
                                items: [
                                    { // Provide a back option to main menu
                                        type: "action",
                                        action: { type: "message", label: "返回主選單", text: "返回上一階段" }
                                    }
                                ]
                            }
                        };
                        return client.replyMessage(event.replyToken, askPhoneMsg);
                    }
                } else {
                    // If text does not match any known command, show the main menu again (help)
                    const replyMsg = createMainMenuFlex("很抱歉，我無法辨識您的輸入。\n請從以下選單選擇服務：");
                    return client.replyMessage(event.replyToken, replyMsg);
                }
            }
        }
        if (event.type === 'message' && event.message.type === 'location') {
            // If user shared a location (for pick-up location)
            const userId = event.source.userId;
            if (sessionState[userId] && sessionState[userId].flow === "booking" && sessionState[userId].step === "location") {
                // Save the address of the location
                const address = event.message.address || (`${event.message.latitude},${event.message.longitude}`);
                sessionState[userId].data.location = address;
                // Move to next step (備註)
                sessionState[userId].step = "note";
                // Ask for note (optional)
                const askNoteMsg = {
                    type: "text",
                    text: "請輸入備註（可選填，輸入「無」表示無備註）：",
                    quickReply: {
                        items: [
                            { type: "action", action: { type: "message", label: "無備註", text: "無備註" } },
                            { type: "action", action: { type: "message", label: "返回上一階段", text: "返回上一階段" } }
                        ]
                    }
                };
                return client.replyMessage(event.replyToken, askNoteMsg);
            }
            // Otherwise ignore if location not expected
            return Promise.resolve(null);
        }
        if (event.type === 'postback') {
            const userId = event.source.userId;
            const data = event.postback.data;
            if (data === "CONFIRM_BOOKING") {
                // User confirmed booking
                if (sessionState[userId] && sessionState[userId].flow === "booking") {
                    const bookingData = sessionState[userId].data;
                    // Save booking record
                    const recordUserId = sessionState[userId].editOriginalUserId || userId;
                    bookingData.userId = recordUserId;
                    bookings[recordUserId] = bookingData;
                    // Map phone to this booking (for lookup by phone)
                    if (bookingData.phone) {
                        // Remove old phone mapping if any
                        for (const p in bookings) {
                            if (bookings[p] && bookings[p].phone === bookingData.phone && p !== recordUserId) {
                                delete bookings[p];
                            }
                        }
                        // Invalidate any other user using same phone (not likely)
                    }
                    // Update user memory for that userId (if editing original and original != current, update original's memory)
                    if (!userMemory[recordUserId]) userMemory[recordUserId] = {};
                    userMemory[recordUserId].phone = bookingData.phone;
                    userMemory[recordUserId].licensePlate = bookingData.licensePlate;
                    userMemory[recordUserId].location = bookingData.location;
                    // If editing via a different user (friend scenario), do not update friend's memory
                    if (sessionState[userId].editOriginalUserId && recordUserId !== userId) {
                        // Friend just helped editing, we won't store friend memory with someone else's data
                    } else {
                        // Otherwise, recordUserId === userId or not editing
                        userMemory[userId] = userMemory[recordUserId];
                    }
                    // Clear session state
                    delete sessionState[userId];
                    // Reply with confirmation message
                    const confirmMsg = {
                        type: "text",
                        text: "預約已確認！我們將依預約時間提供服務，謝謝您。"
                    };
                    // After confirming, optionally show main menu again
                    const menuMsg = createMainMenuFlex("請問還需要其他服務嗎？");
                    return client.replyMessage(event.replyToken, [confirmMsg, menuMsg]);
                } else {
                    // No active booking flow, ignore
                    return Promise.resolve(null);
                }
            }
            // Handle "difference" info requests
            if (data.startsWith("DIFF:")) {
                const subName = data.split("DIFF:")[1];
                // Use current category from session
                if (sessionState[userId] && (sessionState[userId].flow === "booking" || sessionState[userId].flow === "price")) {
                    const currentCategory = sessionState[userId].data.category;
                    if (currentCategory && serviceCategories[currentCategory] && serviceCategories[currentCategory].diff) {
                        const diffText = serviceCategories[currentCategory].diff;
                        // Create Flex message for difference detail
                        const diffFlex = {
                            type: "flex",
                            altText: currentCategory + "服務差異說明",
                            contents: {
                                type: "bubble",
                                styles: {
                                    header: { backgroundColor: "#141E32" }, // mainColor background
                                    body: { backgroundColor: "#F0F0F0" }
                                },
                                header: {
                                    type: "box",
                                    layout: "vertical",
                                    contents: [
                                        {
                                            type: "text",
                                            text: currentCategory + " - 差異說明",
                                            weight: "bold",
                                            color: "#FFFFFF",
                                            size: "md"
                                        }
                                    ]
                                },
                                body: {
                                    type: "box",
                                    layout: "vertical",
                                    contents: [
                                        {
                                            type: "text",
                                            text: diffText,
                                            wrap: true,
                                            color: "#333333",
                                            size: "sm"
                                        }
                                    ]
                                }
                            }
                        };
                        // After showing difference, provide the subcategory menu again
                        const subMenuMsg = createSubcategoryQuickReply(currentCategory, sessionState[userId].flow);
                        return client.replyMessage(event.replyToken, [diffFlex, subMenuMsg]);
                    }
                }
                // If no valid state or diff text, ignore
                return Promise.resolve(null);
            }
            // Handle any other specific postback actions if needed
            return Promise.resolve(null);
        }
    } catch (err) {
        console.error("Error in handleEvent logic:", err);
        // Attempt to reply with a generic error message if possible
        if (event.replyToken) {
            try {
                await client.replyMessage(event.replyToken, { type: 'text', text: "發生錯誤，請稍後再試。" });
            } catch (e) {
                console.error("Failed to send error message:", e);
            }
        }
        return Promise.resolve(null);
    }
}

// Function to handle the "返回上一階段" back navigation
function handleBackAction(replyToken, userId) {
    const state = sessionState[userId];
    if (!state) {
        // No state, just show main menu
        const menuMsg = createMainMenuFlex();
        return client.replyMessage(replyToken, menuMsg);
    }
    const flow = state.flow;
    const step = state.step;
    if (flow === "booking") {
        // Determine previous step in booking flow
        if (step === "category") {
            // Going back from category selection -> exit flow, show main menu
            delete sessionState[userId];
            const menuMsg = createMainMenuFlex();
            return client.replyMessage(replyToken, menuMsg);
        }
        if (step === "subcategory") {
            // Back to category selection
            state.step = "category";
            const msg = createCategoryQuickReply("booking");
            return client.replyMessage(replyToken, msg);
        }
        if (step === "carType") {
            // If category has subcategories, back to subcategory, else back to category
            const currentCategory = state.data.category;
            if (currentCategory && serviceCategories[currentCategory].subs && serviceCategories[currentCategory].subs.length > 0) {
                state.step = "subcategory";
                const msg = createSubcategoryQuickReply(currentCategory, "booking");
                return client.replyMessage(replyToken, msg);
            } else {
                state.step = "category";
                const msg = createCategoryQuickReply("booking");
                return client.replyMessage(replyToken, msg);
            }
        }
        if (step === "licensePlate") {
            // Back to car type
            state.step = "carType";
            const carTypeFlex = createCarTypeFlex();
            return client.replyMessage(replyToken, carTypeFlex);
        }
        if (step === "date") {
            // Back to license plate
            state.step = "licensePlate";
            // Ask license plate again (with memory quick reply if available)
            const licensePrompt = createLicensePlatePrompt(userId);
            return client.replyMessage(replyToken, licensePrompt);
        }
        if (step === "timeSlot") {
            // Back to date
            state.step = "date";
            const askDateMsg = {
                type: "text",
                text: "請輸入預約日期 (YYYY-MM-DD)：",
                quickReply: {
                    items: [
                        { type: "action", action: { type: "message", label: "返回上一階段", text: "返回上一階段" } }
                    ]
                }
            };
            return client.replyMessage(replyToken, askDateMsg);
        }
        if (step === "phone") {
            // Back to timeSlot
            state.step = "timeSlot";
            const askTimeMsg = {
                type: "text",
                text: "請選擇預約時段：",
                quickReply: {
                    items: [
                        { type: "action", action: { type: "message", label: "早上", text: "早上" } },
                        { type: "action", action: { type: "message", label: "下午", text: "下午" } },
                        { type: "action", action: { type: "message", label: "晚上", text: "晚上" } },
                        { type: "action", action: { type: "message", label: "返回上一階段", text: "返回上一階段" } }
                    ]
                }
            };
            return client.replyMessage(replyToken, askTimeMsg);
        }
        if (step === "location") {
            // Back to phone
            state.step = "phone";
            const phonePrompt = createPhonePrompt(userId);
            return client.replyMessage(replyToken, phonePrompt);
        }
        if (step === "note") {
            // Back to location
            state.step = "location";
            const locationPrompt = createLocationPrompt(userId);
            return client.replyMessage(replyToken, locationPrompt);
        }
        if (step === "confirm") {
            // Back to note (allow editing note)
            state.step = "note";
            const askNoteMsg = {
                type: "text",
                text: "請輸入備註（可選填）：",
                quickReply: {
                    items: [
                        { type: "action", action: { type: "message", label: "無備註", text: "無備註" } },
                        { type: "action", action: { type: "message", label: "返回上一階段", text: "返回上一階段" } }
                    ]
                }
            };
            return client.replyMessage(replyToken, askNoteMsg);
        }
    } else if (flow === "price") {
        if (step === "category") {
            // Back from category selection -> main menu
            delete sessionState[userId];
            const menuMsg = createMainMenuFlex();
            return client.replyMessage(replyToken, menuMsg);
        }
        if (step === "subcategory") {
            // Back to category
            state.step = "category";
            const msg = createCategoryQuickReply("price");
            return client.replyMessage(replyToken, msg);
        }
        if (step === "carType") {
            // Back to subcategory
            state.step = "subcategory";
            const currentCategory = state.data.category;
            const msg = createSubcategoryQuickReply(currentCategory, "price");
            return client.replyMessage(replyToken, msg);
        }
        if (step === "priceShown") {
            // Back to carType selection
            state.step = "carType";
            const carTypeFlex = createCarTypeFlex();
            return client.replyMessage(replyToken, carTypeFlex);
        }
    } else if (flow === "change") {
        if (step === "verify") {
            // Back from phone entry -> go to main menu
            delete sessionState[userId];
            const menuMsg = createMainMenuFlex();
            return client.replyMessage(replyToken, menuMsg);
        }
        if (step === "options") {
            // Back from options -> main menu
            delete sessionState[userId];
            const menuMsg = createMainMenuFlex();
            return client.replyMessage(replyToken, menuMsg);
        }
        if (step === "modifyDate" || step === "modifyTime") {
            // Back to options menu
            state.step = "options";
            const optionsMsg = createChangeOptionsQuickReply();
            return client.replyMessage(replyToken, optionsMsg);
        }
        // If in a refill booking flow, the back logic would be handled by booking flow branch since we actually switched flow to booking in that case.
    }
    // Default: if cannot handle, just return main menu
    delete sessionState[userId];
    const menuMsg = createMainMenuFlex();
    return client.replyMessage(replyToken, menuMsg);
}

// Handle booking flow text inputs
function handleBookingFlow(replyToken, userId, text) {
    const state = sessionState[userId];
    const step = state.step;
    const data = state.data;
    if (step === "category") {
        // Expecting a category name
        if (!serviceCategories[text]) {
            // Invalid category, ask again
            const msg = createCategoryQuickReply("booking", "請從選單中選擇服務類別。");
            return client.replyMessage(replyToken, msg);
        }
        // Valid category selected
        data.category = text;
        const categoryInfo = serviceCategories[text];
        if (categoryInfo.subs && categoryInfo.subs.length > 0) {
            // There are subcategories, move to subcategory step
            state.step = "subcategory";
            const msg = createSubcategoryQuickReply(text, "booking");
            return client.replyMessage(replyToken, msg);
        } else {
            // No subcategories (single service in this category)
            data.subcategory = null;
            // Move directly to car type selection
            state.step = "carType";
            const carTypeFlex = createCarTypeFlex();
            return client.replyMessage(replyToken, carTypeFlex);
        }
    }
    if (step === "subcategory") {
        // Expect subcategory name
        const categoryName = data.category;
        const categoryInfo = serviceCategories[categoryName];
        // Check if user entered the name of a subcategory
        const sub = categoryInfo.subs.find(s => s.name === text);
        if (!sub) {
            // Maybe user typed "無備註" by mistake here or an invalid value
            // If text indicates no note but at wrong step, ignore and reprompt
            const msg = createSubcategoryQuickReply(categoryName, "booking", "請選擇服務項目。");
            return client.replyMessage(replyToken, msg);
        }
        // Valid subcategory chosen
        data.subcategory = sub.name;
        state.step = "carType";
        const carTypeFlex = createCarTypeFlex();
        return client.replyMessage(replyToken, carTypeFlex);
    }
    if (step === "carType") {
        // Expect a car type
        if (!carTypeMap[text]) {
            // invalid input
            const carTypeFlex = createCarTypeFlex("請從選項中選擇車型。");
            return client.replyMessage(replyToken, carTypeFlex);
        }
        data.carType = text;
        // Ask for car license plate number
        state.step = "licensePlate";
        const licensePrompt = createLicensePlatePrompt(userId);
        return client.replyMessage(replyToken, licensePrompt);
    }
    if (step === "licensePlate") {
        if (!text || text === "無") {
            // If user just typed nothing or "無", treat as no license (should normally require though)
            data.licensePlate = text === "無" ? "" : "";
        } else {
            data.licensePlate = text;
        }
        // Ask for date
        state.step = "date";
        const askDateMsg = {
            type: "text",
            text: "請輸入預約日期 (YYYY-MM-DD)：",
            quickReply: {
                items: [
                    { type: "action", action: { type: "message", label: "返回上一階段", text: "返回上一階段" } }
                ]
            }
        };
        return client.replyMessage(replyToken, askDateMsg);
    }
    if (step === "date") {
        // Accept any date format for now (just store text)
        data.date = text;
        // Ask for time slot
        state.step = "timeSlot";
        const askTimeMsg = {
            type: "text",
            text: "請選擇預約時段：",
            quickReply: {
                items: [
                    { type: "action", action: { type: "message", label: "早上", text: "早上" } },
                    { type: "action", action: { type: "message", label: "下午", text: "下午" } },
                    { type: "action", action: { type: "message", label: "晚上", text: "晚上" } },
                    { type: "action", action: { type: "message", label: "返回上一階段", text: "返回上一階段" } }
                ]
            }
        };
        return client.replyMessage(replyToken, askTimeMsg);
    }
    if (step === "timeSlot") {
        if (!["早上","下午","晚上"].includes(text)) {
            // invalid, ask again
            const askTimeMsg = {
                type: "text",
                text: "請選擇預約時段（早上/下午/晚上）：",
                quickReply: {
                    items: [
                        { type: "action", action: { type: "message", label: "早上", text: "早上" } },
                        { type: "action", action: { type: "message", label: "下午", text: "下午" } },
                        { type: "action", action: { type: "message", label: "晚上", text: "晚上" } },
                        { type: "action", action: { type: "message", label: "返回上一階段", text: "返回上一階段" } }
                    ]
                }
            };
            return client.replyMessage(replyToken, askTimeMsg);
        }
        data.timeSlot = text;
        // Ask for contact phone
        state.step = "phone";
        const phonePrompt = createPhonePrompt(userId);
        return client.replyMessage(replyToken, phonePrompt);
    }
    if (step === "phone") {
        // Validate phone (basic)
        const phoneNum = text.replace(/[\s-]/g, "");
        if (!/^[0-9]{6,}$/.test(phoneNum)) {
            const errorMsg = {
                type: "text",
                text: "電話格式不正確，請重新輸入：",
                quickReply: {
                    items: [
                        { type: "action", action: { type: "message", label: "返回上一階段", text: "返回上一階段" } }
                    ]
                }
            };
            return client.replyMessage(replyToken, errorMsg);
        }
        data.phone = phoneNum;
        // Ask for pick-up location
        state.step = "location";
        const locationPrompt = createLocationPrompt(userId);
        return client.replyMessage(replyToken, locationPrompt);
    }
    if (step === "location") {
        if (text === "無") text = ""; // if user typed '無', treat as empty
        data.location = text;
        // Ask for note
        state.step = "note";
        const askNoteMsg = {
            type: "text",
            text: "請輸入備註（可選填，無則輸入「無」）：",
            quickReply: {
                items: [
                    { type: "action", action: { type: "message", label: "無備註", text: "無備註" } },
                    { type: "action", action: { type: "message", label: "返回上一階段", text: "返回上一階段" } }
                ]
            }
        };
        return client.replyMessage(replyToken, askNoteMsg);
    }
    if (step === "note") {
        data.note = (text === "無備註" || text === "無") ? "" : text;
        // Prepare summary Flex message
        state.step = "confirm";
        const summaryFlex = createBookingSummaryFlex(data);
        // Include confirm button in Flex (postback) and possibly a back quick reply
        return client.replyMessage(replyToken, summaryFlex);
    }
    // Unexpected step
    return client.replyMessage(replyToken, { type: "text", text: "發生未知錯誤，請重新開始預約流程。" });
}

// Handle price inquiry flow text inputs
function handlePriceFlow(replyToken, userId, text) {
    const state = sessionState[userId];
    const step = state.step;
    const data = state.data;
    if (step === "category") {
        if (!serviceCategories[text]) {
            const msg = createCategoryQuickReply("price", "請從選單中選擇服務類別。");
            return client.replyMessage(replyToken, msg);
        }
        data.category = text;
        const categoryInfo = serviceCategories[text];
        if (categoryInfo.subs && categoryInfo.subs.length > 0) {
            state.step = "subcategory";
            const msg = createSubcategoryQuickReply(text, "price");
            return client.replyMessage(replyToken, msg);
        } else {
            data.subcategory = null;
            state.step = "carType";
            const carTypeFlex = createCarTypeFlex();
            return client.replyMessage(replyToken, carTypeFlex);
        }
    }
    if (step === "subcategory") {
        const categoryName = data.category;
        const categoryInfo = serviceCategories[categoryName];
        const sub = categoryInfo.subs.find(s => s.name === text);
        if (!sub) {
            const msg = createSubcategoryQuickReply(categoryName, "price", "請選擇服務項目。");
            return client.replyMessage(replyToken, msg);
        }
        data.subcategory = sub.name;
        state.step = "carType";
        const carTypeFlex = createCarTypeFlex();
        return client.replyMessage(replyToken, carTypeFlex);
    }
    if (step === "carType") {
        if (!carTypeMap[text]) {
            const carTypeFlex = createCarTypeFlex("請從選項中選擇車型。");
            return client.replyMessage(replyToken, carTypeFlex);
        }
        data.carType = text;
        // Got all info needed to show price
        state.step = "priceShown";
        // Determine price from data
        let price = 0;
        const categoryName = data.category;
        const categoryInfo = serviceCategories[categoryName];
        const carKey = carTypeMap[data.carType];
        if (data.subcategory) {
            const subInfo = categoryInfo.subs.find(s => s.name === data.subcategory);
            price = subInfo ? subInfo.prices[carKey] : 0;
        } else {
            price = categoryInfo.prices ? categoryInfo.prices[carKey] : 0;
        }
        const priceText = `${categoryName}${data.subcategory ? " - " + data.subcategory : ""} (${data.carType}) 的價格為 $${price} 元。`;
        const priceMsg = {
            type: "text",
            text: priceText,
            quickReply: {
                items: [
                    { type: "action", action: { type: "message", label: "我要預約", text: "我要預約" } },
                    { type: "action", action: { type: "message", label: "返回", text: "返回上一階段" } }
                ]
            }
        };
        return client.replyMessage(replyToken, priceMsg);
    }
    if (step === "priceShown") {
        // The only expected messages at this point are "我要預約" or "返回上一階段" (back handled separately).
        if (text === "我要預約") {
            // User wants to proceed to booking for the selected service
            // We can carry over category, subcategory, carType to new booking flow
            const categoryName = state.data.category;
            const subName = state.data.subcategory;
            const carType = state.data.carType;
            // Initialize booking flow for user
            sessionState[userId] = { flow: "booking", step: "licensePlate", data: { category: categoryName, subcategory: subName, carType: carType } };
            // Ask for license plate next (skipping category and sub selection)
            const licensePrompt = createLicensePlatePrompt(userId);
            return client.replyMessage(replyToken, licensePrompt);
        }
        // If some other text, just ignore or treat as back (back is handled in handleBackAction)
    }
    return Promise.resolve(null);
}

// Handle change booking flow text inputs
function handleChangeFlow(replyToken, userId, text) {
    const state = sessionState[userId];
    const step = state.step;
    if (step === "verify") {
        // Expecting phone or userId input
        const query = text.trim();
        let found = null;
        // If user entered something that looks like a LINE userID (starts with U and length > 10)
        if (/^U[a-zA-Z0-9]{32,}$/.test(query)) {
            found = bookings[query] || null;
        }
        // If not found yet, try phone
        if (!found) {
            // search bookings by phone number
            for (const uid in bookings) {
                if (bookings[uid] && bookings[uid].phone === query) {
                    found = bookings[uid];
                    break;
                }
            }
        }
        if (!found) {
            // Not found
            const notFoundMsg = {
                type: "text",
                text: "查無此電話的預約紀錄，請確認電話輸入正確。"
            };
            // End change flow or allow retry? We'll end it here for simplicity
            delete sessionState[userId];
            const menuMsg = createMainMenuFlex();
            return client.replyMessage(replyToken, [notFoundMsg, menuMsg]);
        }
        // Found booking
        state.data.foundBooking = found;
        state.step = "options";
        const optionsMsg = createChangeOptionsQuickReply();
        return client.replyMessage(replyToken, optionsMsg);
    }
    if (step === "options") {
        if (text === "重新填寫預約單") {
            // Start a refill booking flow (basically new booking pre-filled with old info)
            const oldBooking = state.data.foundBooking;
            sessionState[userId] = { flow: "booking", step: "category", data: {}, editOriginalUserId: oldBooking.userId };
            // We will let user choose category anew (they might change service too), but we can pre-fill memory so reuse suggestions appear.
            // Set userMemory for current user from oldBooking data (so that quick replies can suggest previous info)
            userMemory[userId] = {
                phone: oldBooking.phone,
                licensePlate: oldBooking.licensePlate,
                location: oldBooking.location
            };
            // Present category menu for booking
            const msg = createCategoryQuickReply("booking", "請選擇新的服務類別：");
            return client.replyMessage(replyToken, msg);
        } else if (text === "修改日期時段") {
            // Only change date/time for the existing booking
            state.step = "modifyDate";
            const askDateMsg = {
                type: "text",
                text: "請輸入新的預約日期 (YYYY-MM-DD)：",
                quickReply: {
                    items: [
                        { type: "action", action: { type: "message", label: "返回上一階段", text: "返回上一階段" } }
                    ]
                }
            };
            return client.replyMessage(replyToken, askDateMsg);
        } else if (text === "取消預約") {
            const bookingToCancel = state.data.foundBooking;
            // Remove booking
            if (bookingToCancel) {
                delete bookings[bookingToCancel.userId];
            }
            delete sessionState[userId];
            const cancelMsg = { type: "text", text: "您的預約已取消。" };
            const menuMsg = createMainMenuFlex();
            return client.replyMessage(replyToken, [cancelMsg, menuMsg]);
        } else {
            // Unrecognized input
            const optionsMsg = createChangeOptionsQuickReply("請從選項中選擇要執行的動作。");
            return client.replyMessage(replyToken, optionsMsg);
        }
    }
    if (step === "modifyDate") {
        // Store new date in found booking
        state.data.newDate = text;
        state.step = "modifyTime";
        const askTimeMsg = {
            type: "text",
            text: "請選擇新的預約時段：",
            quickReply: {
                items: [
                    { type: "action", action: { type: "message", label: "早上", text: "早上" } },
                    { type: "action", action: { type: "message", label: "下午", text: "下午" } },
                    { type: "action", action: { type: "message", label: "晚上", text: "晚上" } },
                    { type: "action", action: { type: "message", label: "返回上一階段", text: "返回上一階段" } }
                ]
            }
        };
        return client.replyMessage(replyToken, askTimeMsg);
    }
    if (step === "modifyTime") {
        if (!["早上","下午","晚上"].includes(text)) {
            const askTimeMsg = {
                type: "text",
                text: "請選擇預約時段（早上/下午/晚上）：",
                quickReply: {
                    items: [
                        { type: "action", action: { type: "message", label: "早上", text: "早上" } },
                        { type: "action", action: { type: "message", label: "下午", text: "下午" } },
                        { type: "action", action: { type: "message", label: "晚上", text: "晚上" } },
                        { type: "action", action: { type: "message", label: "返回上一階段", text: "返回上一階段" } }
                    ]
                }
            };
            return client.replyMessage(replyToken, askTimeMsg);
        }
        state.data.newTimeSlot = text;
        // Apply changes
        const bookingToUpdate = state.data.foundBooking;
        if (bookingToUpdate) {
            bookingToUpdate.date = state.data.newDate;
            bookingToUpdate.timeSlot = state.data.newTimeSlot;
        }
        // Confirm updated
        delete sessionState[userId];
        const updatedMsg = {
            type: "text",
            text: `您的預約已更改為 ${bookingToUpdate.date} ${bookingToUpdate.timeSlot}。`
        };
        const menuMsg = createMainMenuFlex();
        return client.replyMessage(replyToken, [updatedMsg, menuMsg]);
    }
    // Default fall-through
    return Promise.resolve(null);
}

// Utility: create main menu Flex message (with optional intro text)
function createMainMenuFlex(introText) {
    // A single bubble with 3 buttons in footer for main options
    const bubble = {
        type: "bubble",
        hero: {
            type: "image",
            url: "https://scdn.line-apps.com/n/channel_devcenter/img/fx/01_2_restaurant.png",
            size: "full",
            aspectRatio: "20:13",
            aspectMode: "cover"
        },
        body: {
            type: "box",
            layout: "vertical",
            contents: [
                {
                    type: "text",
                    text: introText ? introText : "歡迎使用汽車美容預約系統，請選擇服務：",
                    wrap: true,
                    weight: "bold",
                    size: "md"
                }
            ]
        },
        footer: {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            contents: [
                {
                    type: "button",
                    style: "primary",
                    color: "#141E32",
                    height: "sm",
                    action: { type: "message", label: "我要預約", text: "我要預約" }
                },
                {
                    type: "button",
                    style: "primary",
                    color: "#141E32",
                    height: "sm",
                    action: { type: "message", label: "查詢價格", text: "查詢價格" }
                },
                {
                    type: "button",
                    style: "primary",
                    color: "#141E32",
                    height: "sm",
                    action: { type: "message", label: "更改預約", text: "更改預約" }
                },
                {
                    type: "spacer",
                    size: "xs"
                }
            ],
            flex: 0
        },
        styles: {
            footer: {
                separator: false
            }
        }
    };
    return { type: "flex", altText: "主選單", contents: bubble };
}

// Utility: create category selection quick reply (for booking or price flows)
function createCategoryQuickReply(flow, promptText) {
    const prompt = promptText ? promptText : "請選擇服務分類：";
    const items = [];
    for (const cat of Object.keys(serviceCategories)) {
        items.push({
            type: "action",
            action: { type: "message", label: cat, text: cat }
        });
    }
    // Add a cancel/back to main menu option if needed (though main menu itself)
    items.push({
        type: "action",
        action: { type: "message", label: "取消", text: "返回上一階段" }
    });
    return {
        type: "text",
        text: prompt,
        quickReply: { items: items }
    };
}

// Utility: create subcategory selection quick reply for a given category
function createSubcategoryQuickReply(categoryName, flow, promptText) {
    const categoryInfo = serviceCategories[categoryName];
    const prompt = promptText ? promptText : `請選擇「${categoryName}」的服務項目：`;
    const items = [];
    for (const sub of categoryInfo.subs) {
        // Option for the subcategory
        items.push({
            type: "action",
            action: { type: "message", label: sub.name, text: sub.name }
        });
        // Option for difference explanation (only if category has multiple subs)
        if (categoryInfo.subs.length > 1) {
            items.push({
                type: "action",
                action: {
                    type: "postback",
                    label: sub.name + "差異",
                    data: "DIFF:" + sub.name,
                    displayText: `${sub.name}有什麼區別?`
                }
            });
        }
    }
    // Add back option
    items.push({
        type: "action",
        action: { type: "message", label: "返回上一階段", text: "返回上一階段" }
    });
    return {
        type: "text",
        text: prompt,
        quickReply: { items: items }
    };
}

// Utility: create car type selection Flex (carousel of options)
function createCarTypeFlex(promptText) {
    const prompt = promptText ? promptText : "請選擇您的車型：";
    const carTypes = ["小型車", "中型車", "大型車/SUV"];
    const bubbles = carTypes.map(type => {
        return {
            type: "bubble",
            size: "micro",
            body: {
                type: "box",
                layout: "vertical",
                contents: [
                    {
                        type: "text",
                        text: type,
                        weight: "bold",
                        size: "sm",
                        wrap: true
                    },
                    {
                        type: "text",
                        text: getCarTypeExample(type),
                        size: "xs",
                        color: "#666666",
                        wrap: true
                    }
                ],
                action: { type: "message", label: type, text: type }
            },
            styles: {
                body: {
                    backgroundColor: "#F0F0F0"
                }
            }
        };
    });
    const carousel = {
        type: "carousel",
        contents: bubbles
    };
    // We'll send the prompt as a separate text with carousel flex, because altText can cover only the flex content.
    return [
        { type: "text", text: prompt },
        { type: "flex", altText: "請選擇車型", contents: carousel }
    ];
}

// Helper: get example text for car type
function getCarTypeExample(type) {
    if (type === "小型車") return "例如：Yaris、Fit";
    if (type === "中型車") return "例如：Corolla、Civic";
    if (type === "大型車/SUV") return "例如：RAV4、CR-V";
    return "";
}

// Utility: create license plate prompt message (with quick reply to use memory if available)
function createLicensePlatePrompt(userId) {
    const memory = userMemory[userId];
    const quickItems = [];
    let prompt = "請輸入您的車牌號碼：";
    if (memory && memory.licensePlate) {
        quickItems.push({
            type: "action",
            action: { type: "message", label: `沿用上次車號 ${memory.licensePlate}`, text: memory.licensePlate }
        });
    }
    quickItems.push({
        type: "action",
        action: { type: "message", label: "返回上一階段", text: "返回上一階段" }
    });
    return {
        type: "text",
        text: prompt,
        quickReply: { items: quickItems }
    };
}

// Utility: create phone prompt message (with quick reply for using previous phone)
function createPhonePrompt(userId) {
    const memory = userMemory[userId];
    const quickItems = [];
    let prompt = "請輸入聯絡電話：";
    if (memory && memory.phone) {
        quickItems.push({
            type: "action",
            action: { type: "message", label: `沿用上次電話 ${memory.phone}`, text: memory.phone }
        });
    }
    quickItems.push({
        type: "action",
        action: { type: "message", label: "返回上一階段", text: "返回上一階段" }
    });
    return {
        type: "text",
        text: prompt,
        quickReply: { items: quickItems }
    };
}

// Utility: create location prompt message (with quick reply for using previous location or share location)
function createLocationPrompt(userId) {
    const memory = userMemory[userId];
    const quickItems = [];
    let prompt = "請輸入取車地點：";
    if (memory && memory.location) {
        quickItems.push({
            type: "action",
            action: { type: "message", label: `沿用上次地點`, text: memory.location }
        });
    }
    // Optionally, offer location share action
    quickItems.push({
        type: "action",
        action: { type: "location", label: "傳送目前位置" }
    });
    quickItems.push({
        type: "action",
        action: { type: "message", label: "返回上一階段", text: "返回上一階段" }
    });
    return {
        type: "text",
        text: prompt,
        quickReply: { items: quickItems }
    };
}

// Utility: create booking summary Flex message with confirm button
function createBookingSummaryFlex(data) {
    const category = data.category;
    const serviceName = data.subcategory ? `${category} - ${data.subcategory}` : category;
    const infoRows = [];
    infoRows.push(makeKeyValueBox("服務項目", serviceName));
    infoRows.push(makeKeyValueBox("車型", data.carType));
    if (data.licensePlate) {
        infoRows.push(makeKeyValueBox("車牌號碼", data.licensePlate));
    }
    infoRows.push(makeKeyValueBox("日期", data.date));
    infoRows.push(makeKeyValueBox("時段", data.timeSlot));
    infoRows.push(makeKeyValueBox("電話", data.phone));
    infoRows.push(makeKeyValueBox("地點", data.location || "無"));
    infoRows.push(makeKeyValueBox("備註", data.note && data.note !== "" ? data.note : "無"));
    const bubble = {
        type: "bubble",
        styles: {
            header: { backgroundColor: "#141E32" },
            footer: { separator: true }
        },
        header: {
            type: "box",
            layout: "vertical",
            contents: [
                { type: "text", text: "預約確認", weight: "bold", color: "#FFFFFF", size: "lg" }
            ]
        },
        body: {
            type: "box",
            layout: "vertical",
            contents: infoRows
        },
        footer: {
            type: "box",
            layout: "vertical",
            contents: [
                {
                    type: "button",
                    style: "primary",
                    height: "md",
                    color: "#141E32",
                    action: { type: "postback", label: "確認送出", data: "CONFIRM_BOOKING" }
                },
                {
                    type: "button",
                    style: "secondary",
                    height: "sm",
                    action: { type: "message", label: "返回上一階段", text: "返回上一階段" }
                }
            ]
        }
    };
    return { type: "flex", altText: "預約資訊確認", contents: bubble };
}

// Helper: make a horizontal box with label and value text for summary
function makeKeyValueBox(label, value) {
    return {
        type: "box",
        layout: "horizontal",
        contents: [
            {
                type: "text",
                text: label,
                size: "sm",
                color: "#555555",
                flex: 2
            },
            {
                type: "text",
                text: value,
                size: "sm",
                color: "#111111",
                flex: 4,
                wrap: true
            }
        ]
    };
}

// Utility: create quick reply for change options (refill, modify time, cancel)
function createChangeOptionsQuickReply(promptText) {
    const prompt = promptText ? promptText : "請選擇要執行的動作：";
    return {
        type: "text",
        text: prompt,
        quickReply: {
            items: [
                { type: "action", action: { type: "message", label: "重新填寫預約單", text: "重新填寫預約單" } },
                { type: "action", action: { type: "message", label: "修改日期時段", text: "修改日期時段" } },
                { type: "action", action: { type: "message", label: "取消預約", text: "取消預約" } },
                { type: "action", action: { type: "message", label: "返回主選單", text: "返回上一階段" } }
            ]
        }
    };
}

// Start the server
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`LINE bot server running on port ${port}`);
});
