const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
const port = process.env.PORT || 3000;
const accessToken = process.env.LINE_ACCESS_TOKEN;

if (!accessToken) {
  console.error('錯誤：LINE_ACCESS_TOKEN 未設置');
  process.exit(1);
}

app.use(bodyParser.json());

// 全局 session，保存每位使用者的預約進度與資料
const sessions = new Map();

/* 
  預設服務資料：服務大類、各分類內細項
  你可以視需要擴充或改用外部資料配置
*/
const serviceData = {
  "清潔養護": {
    subOptions: ["基礎護理", "深層護理", "有什麼區別？"],
    // 說明內容會用 Flex 卡片發送
    description: {
      "有什麼區別？": "【基礎護理】適合平日定期洗車、車況較好；【深層護理】適合較久未洗或要求更高，兩者皆採用棕櫚蠟，但蠟品等級不同。"
    }
  },
  "拋光美容": {
    subOptions: ["漆面美白", "80%無痕拋光", "99%無痕拋光", "有什麼區別？"],
    description: {
      "有什麼區別？": "【漆面美白】推薦較久未洗且淺色車，能修復太陽紋及刮傷；【80%/99%無痕拋光】主要用於修復深層刮傷，效果依需求不同而有所區隔。"
    }
  },
  "鍍膜套餐": {
    subOptions: ["鍍膜1年期", "鍍膜2年期", "一年兩年有什麼區別？", "鍍膜介紹"],
    description: {
      "一年兩年有什麼區別？": "一年與兩年套餐差異主要在於鍍膜層數及維持時間；保固內若有自然衰退，均可免費補鍍。",
      "鍍膜介紹": "本店採用石英鍍膜，化學鍵結方式與車漆融合，硬度高（達9H）、形成疏水抗污塗層，持久性優，耐紫外線與氧化。"
    }
  },
  "玻璃鍍膜+除油膜": {
    subOptions: ["全車玻璃鍍膜+除油膜", "鍍膜介紹"],
    description: {
      "鍍膜介紹": "本店的玻璃鍍膜採用專業技術，能有效防止污漬與水痕，確保玻璃長期清透。"
    }
  }
};

// 以各服務大類對應的價格（簡單示範，實際可再細分）
const servicePricing = {
  "基礎護理": { "一般轎車": 800, "大型轎車": 1000, "休旅車": 1200 },
  "深層護理": { "一般轎車": 1200, "大型轎車": 1400, "休旅車": 1600 },
  "漆面美白": { "一般轎車": 2500, "大型轎車": 3500, "休旅車": 4500 },
  "80%無痕拋光": { "一般轎車": 4000, "大型轎車": 6000, "休旅車": 7000 },
  "99%無痕拋光": { "一般轎車": 6000, "大型轎車": 9000, "休旅車": 9000 },
  "鍍膜1年期": { "一般轎車": 10000, "大型轎車": 12000, "休旅車": 13000 },
  "鍍膜2年期": { "一般轎車": 14000, "大型轎車": 16000, "休旅車": 17000 },
  "全車玻璃鍍膜+除油膜": { "一般轎車": 800, "大型轎車": 800, "休旅車": 800 }
};

/* Utility: 回覆訊息 */
async function replyMessage(replyToken, messages) {
  // 允許 messages 為字串或物件
  const normalized = Array.isArray(messages)
    ? messages
    : [typeof messages === "string" ? { type: "text", text: messages } : messages];
  try {
    const response = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`
      },
      body: JSON.stringify({ replyToken, messages: normalized })
    });
    if (!response.ok) {
      console.error("LINE API 回應錯誤:", await response.text());
    }
  } catch (error) {
    console.error("發送訊息失敗:", error);
  }
}

/* Utility: 建立 Quick Reply 組件 */
function quickReplyItems(labels) {
  return labels.map(label => ({
    type: "action",
    action: { type: "message", label: label, text: label }
  }));
}

/* Utility: "返回上一階段" 按鈕 */
const backButton = {
  type: "action",
  action: { type: "message", label: "↩️ 返回上一階段", text: "返回" }
};

/* 主流程處理：狀態機模式 */
function handleUserInput(userId, message, session, replyToken) {
  const { step, data } = session;

  // 檢查是否有未完成預約：若用戶傳送非預約相關訊息時，提醒續接
  if (step !== "idle" && message !== "重新預約" && message !== "返回") {
    // 若收到「返回」按鈕文字，我們統一處理返回邏輯
    if (message === "返回") {
      // 返回上一階段：根據當前 step 定義返回邏輯
      switch (step) {
        case "chooseSubcategory": // 從小分類返回大分類
          session.step = "chooseCategory";
          promptCategory(replyToken);
          return;
        case "chooseCarType":
          session.step = "chooseSubcategory";
          promptSubcategory(data.category, replyToken);
          return;
        case "inputDate":
          session.step = "chooseCarType";
          promptCarType(data.service, replyToken);
          return;
        case "chooseTime":
          session.step = "inputDate";
          promptDate(replyToken);
          return;
        case "inputPhone":
          session.step = "chooseTime";
          promptTime(replyToken);
          return;
        case "inputLocation":
          session.step = "inputPhone";
          replyMessage(replyToken, "請輸入聯絡電話（8～12 位數）");
          return;
        case "inputRemark":
          session.step = "inputLocation";
          replyMessage(replyToken, "請輸入取車地點");
          return;
        case "confirm":
          session.step = "inputRemark";
          promptRemark(replyToken);
          return;
        default:
          // 若在初始階段則回主選單
          session.step = "idle";
          promptMainMenu(replyToken);
          return;
      }
    }
  }

  /* 開始各狀態流程判斷 */
  switch (step) {
    case "idle":
      // 檢查是否有未完成流程記錄
      // 如果有，提醒是否續接
      if (Object.keys(data).length > 0) {
        session.step = "continuePrompt";
        replyMessage(replyToken, {
          type: "template",
          altText: "續接預約流程",
          template: {
            type: "confirm",
            text: "您尚未完成上一筆預約，是否繼續？",
            actions: [
              { type: "message", label: "是", text: "繼續預約" },
              { type: "message", label: "否", text: "重新預約" }
            ]
          }
        });
        return;
      }
      // 若傳送「我要預約」則開始流程
      if (message === "我要預約") {
        session.step = "chooseCategory";
        promptCategory(replyToken);
      } else {
        promptMainMenu(replyToken);
      }
      return;

    case "continuePrompt":
      if (message === "繼續預約") {
        // 繼續從上次進度回復
        replyMessage(replyToken, "好的，我們繼續預約流程。");
      } else if (message === "重新預約") {
        session.data = {};
      }
      session.step = "chooseCategory";
      promptCategory(replyToken);
      return;

    case "chooseCategory":
      // 預約主流程大分類
      // 此處只接受服務類別，必須是 serviceData 的 key
      if (!serviceData.hasOwnProperty(message)) {
        replyMessage(replyToken, "請從按鈕中選擇有效的服務大分類。");
        promptCategory(replyToken);
        return;
      }
      data.category = message;
      data.service = ""; // 小分類選項將決定
      session.step = "chooseSubcategory";
      promptSubcategory(message, replyToken);
      return;

    case "chooseSubcategory":
      // 處理小分類選擇
      // 除了特定文字 "有什麼區別？" 與 "返回" 以外，必須在此階段允許：用戶點選細項
      if (!serviceData[data.category].subOptions.includes(message) && message !== "有什麼區別？") {
        replyMessage(replyToken, "請從按鈕中選擇有效的小分類或點擊「有什麼區別？」瞭解差異。");
        promptSubcategory(data.category, replyToken);
        return;
      }
      if (message === "有什麼區別？") {
        // 回傳說明文字（Flex Message 可提升效果，這裡用文字示例）
        replyMessage(replyToken, {
          type: "text",
          text: serviceData[data.category].description["有什麼區別？"]
        });
        // 重新發送小分類選項
        setTimeout(() => {
          promptSubcategory(data.category, replyToken);
        }, 500);
        return;
      }
      // 紀錄細項服務選項 (如：基礎護理、深層護理 或其他)
      data.service = message;
      session.step = "chooseCarType";
      promptCarType(message, replyToken);
      return;

    case "chooseCarType":
      // 處理車型選擇，僅接受 '一般轎車','大型轎車','休旅車'
      if (!["一般轎車", "大型轎車", "休旅車"].includes(message)) {
        replyMessage(replyToken, "請從按鈕中選擇有效的車型。");
        promptCarType(data.service, replyToken);
        return;
      }
      data.carType = message;
      session.step = "inputDate";
      // 從價格資料中讀取價格（根據小分類服務，而非大分類）
      let price;
      if (data.category === "鍍膜套餐") {
        // 對於鍍膜套餐，我們以選項直接帶出價格後續可能變動
        price = servicePricing[message] || "待議";
      } else if (data.category === "玻璃鍍膜+除油膜") {
        price = servicePricing["全車玻璃鍍膜+除油膜"];
      } else {
        price = servicePricing[data.service] ? servicePricing[data.service][message] : "待議";
      }
      data.price = price;
      replyMessage(replyToken, `您選擇的是【${data.category}】 > 【${data.service}】\n車型：${message}\n價格：${price} 元`);
      promptDate(replyToken);
      return;

    case "inputDate":
      // 日期以格式 YYYY-MM-DD 驗證
      if (!/^\d{4}-\d{2}-\d{2}$/.test(message)) {
        replyMessage(replyToken, "日期格式錯誤，請輸入類似 2025-04-20 的格式");
        promptDate(replyToken);
        return;
      }
      data.date = message;
      session.step = "chooseTime";
      promptTime(replyToken);
      return;

    case "chooseTime":
      if (!["早上", "下午", "晚上"].includes(message)) {
        replyMessage(replyToken, "請從按鈕中選擇有效的時段。");
        promptTime(replyToken);
        return;
      }
      data.time = message;
      session.step = "inputPhone";
      replyMessage(replyToken, "請輸入聯絡電話（8～12位數字）");
      return;

    case "inputPhone":
      if (!/^\d{8,12}$/.test(message)) {
        replyMessage(replyToken, "電話格式錯誤，請輸入8～12位數字");
        replyMessage(replyToken, "請輸入聯絡電話（8～12位數字）");
        return;
      }
      data.phone = message;
      session.step = "inputLocation";
      replyMessage(replyToken, "請輸入取車地點");
      return;

    case "inputLocation":
      if (!message.trim()) {
        replyMessage(replyToken, "取車地點不能為空，請重新輸入");
        return;
      }
      data.location = message;
      session.step = "inputRemark";
      // 提示備註選填：以 Quick Reply 加上「跳過備註」按鈕
      replyMessage(replyToken, {
        type: "text",
        text: "請輸入備註（如有特殊需求，選填）；若無請點【跳過備註】",
        quickReply: {
          items: [
            {
              type: "action",
              action: { type: "message", label: "跳過備註", text: "無備註" }
            },
            backButton
          ]
        }
      });
      return;

    case "inputRemark":
      // 備註可空，若用戶選擇「無備註」則自動記錄
      data.remark = message === "無備註" ? "" : message;
      session.step = "confirm";
      // 進入預約確認階段
      promptConfirmation(replyToken, data);
      return;

    case "confirm":
      if (message === "確認送出") {
        // 預約完成，記錄使用者ID和該筆資料（可以整合寫入 Google Sheet 之後）
        // 這裡只是回覆成功訊息
        replyMessage(replyToken, "✅ 預約已送出！我們會盡快與您聯繫。");
        // 此處亦可把 data 寫入資料庫或 Google Sheet
        sessions.delete(userId);
      } else if (message === "重新填寫" || message === "返回") {
        // 用戶選擇重新填寫或返回預約確認，返回上一步
        session.step = "inputRemark";
        replyMessage(replyToken, "請輸入備註（選填），或點擊【跳過備註】");
      } else {
        replyMessage(replyToken, "請點選【確認送出】或【重新填寫】");
      }
      return;

    default:
      // 若狀態未知，重置
      sessions.delete(userId);
      promptMainMenu(replyToken);
      return;
  }
}

/* 各步驟的提示函式，包含返回上一階段按鈕 */
function promptMainMenu(replyToken) {
  replyMessag
