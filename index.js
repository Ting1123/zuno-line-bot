const line = require('@line/bot-sdk');
const express = require('express');
require('dotenv').config();

// LINE Bot channel configuration
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

// Create LINE SDK client and Express app
const client = new line.Client(config);
const app = express();

// In-memory state for multi-step flows (per user)
const userState = {};

// Webhook endpoint
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then(() => res.status(200).end())
    .catch(err => {
      console.error(err);
      res.status(500).end();
    });
});

// Main event handler
async function handleEvent(event) {
  // Handle text messages from user
  if (event.type === 'message' && event.message.type === 'text') {
    const userId = event.source.userId;
    const text = event.message.text;

    // Global action: Return to main menu
    if (text === '返回主選單') {
      // Clear any ongoing flow state
      delete userState[userId];
      // Show main menu
      return client.replyMessage(event.replyToken, mainMenuMessage());
    }

    // If user is in the middle of a booking flow
    if (userState[userId] && userState[userId].flow === 'booking') {
      return handleBookingFlow(userId, text, event.replyToken);
    }
    // If user is in the middle of a change-reservation flow
    if (userState[userId] && userState[userId].flow === 'change') {
      return handleChangeFlow(userId, text, event.replyToken);
    }

    // Not in a multi-step flow: handle main menu selections
    if (text === '我要預約') {
      // Start booking process
      userState[userId] = { flow: 'booking', step: 1, data: {} };
      return client.replyMessage(event.replyToken, bookingAskServiceMessage());
    }
    if (text === '查詢價格') {
      // Show service categories for price inquiry
      return client.replyMessage(event.replyToken, categoryMenuMessage());
    }
    if (text === '更改預約') {
      // Start change-reservation process
      userState[userId] = { flow: 'change', step: 1 };
      return client.replyMessage(event.replyToken, changeAskInfoMessage());
    }
    if (text === '專人服務') {
      // Escalate to human service
      delete userState[userId];
      const messages = [
        { type: 'text', text: '專人會盡快接管系統聯繫您' },
        mainMenuMessage()  // After notifying, show main menu again
      ];
      return client.replyMessage(event.replyToken, messages);
    }

    // Handle service category selection (from price inquiry menu)
    if (['清潔養護', '拋光美容', '鍍膜套餐', '全車玻璃鍍膜+除油膜'].includes(text)) {
      return client.replyMessage(event.replyToken, priceDetailMessage(text));
    }

    // Fallback for unrecognized input
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '抱歉，我無法辨識您的請求。您可以從主選單選擇服務。',
      quickReply: {
        items: [
          {
            type: 'action',
            action: { type: 'message', label: '返回主選單', text: '返回主選單' }
          }
        ]
      }
    });
  }
  // Handle postback events (e.g., "What's the difference?" selections)
  else if (event.type === 'postback') {
    const data = event.postback.data;
    if (data.startsWith('diff_')) {
      const categoryKey = data.split('_')[1];  // e.g., "cleaning", "polishing", "coating"
      return client.replyMessage(event.replyToken, differenceMessage(categoryKey));
    }
    // (Additional postback handling, such as date picker, can be added here)
  }
  // Handle new follower event (send main menu as welcome message)
  else if (event.type === 'follow') {
    return client.replyMessage(event.replyToken, mainMenuMessage());
  }

  return Promise.resolve(null);
}

// Construct main menu Flex message
function mainMenuMessage() {
  return {
    type: 'flex',
    altText: '主選單 - 感謝您聯繫ZUNO客服系統',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: '感謝您聯繫ZUNO客服系統',
            wrap: true,
            weight: 'bold',
            size: 'lg',
            align: 'center'
          }
        ],
        backgroundColor: '#D3D3D3'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'button',
            style: 'secondary',
            color: '#AAAAAA',
            action: { type: 'message', label: '我要預約', text: '我要預約' }
          },
          {
            type: 'button',
            style: 'secondary',
            color: '#AAAAAA',
            action: { type: 'message', label: '查詢價格', text: '查詢價格' }
          },
          {
            type: 'button',
            style: 'secondary',
            color: '#AAAAAA',
            action: { type: 'message', label: '更改預約', text: '更改預約' }
          },
          {
            type: 'button',
            style: 'secondary',
            color: '#AAAAAA',
            action: { type: 'message', label: '專人服務', text: '專人服務' }
          }
        ]
      }
    }
  };
}

// Construct service category selection menu (for price inquiry)
function categoryMenuMessage() {
  return {
    type: 'flex',
    altText: '服務項目類別選單',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: '請選擇服務類別',
            wrap: true,
            weight: 'bold',
            size: 'lg',
            align: 'center'
          }
        ],
        backgroundColor: '#D3D3D3'
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'button',
            style: 'primary',
            action: { type: 'message', label: '清潔養護', text: '清潔養護' }
          },
          {
            type: 'button',
            style: 'primary',
            action: { type: 'message', label: '拋光美容', text: '拋光美容' }
          },
          {
            type: 'button',
            style: 'primary',
            action: { type: 'message', label: '鍍膜套餐', text: '鍍膜套餐' }
          },
          {
            type: 'button',
            style: 'primary',
            action: { type: 'message', label: '全車玻璃鍍膜+除油膜', text: '全車玻璃鍍膜+除油膜' }
          }
        ]
      }
    }
  };
}

// Provide price details for each service category
function priceDetailMessage(category) {
  let text = '';
  let quickReplyItems = [];
  if (category === '清潔養護') {
    text = '清潔養護 - 價格表：\n'
         + '基礎護理：轎車 $800；大型轎車 $1000；休旅車 $1200\n'
         + '深層護理：轎車 $1200；大型轎車 $1400；休旅車 $1600';
    quickReplyItems = [
      {
        type: 'action',
        action: { type: 'postback', label: '有什麼區別？', data: 'diff_cleaning', displayText: '有什麼區別？' }
      },
      {
        type: 'action',
        action: { type: 'message', label: '返回主選單', text: '返回主選單' }
      }
    ];
  } else if (category === '拋光美容') {
    text = '拋光美容 - 價格表：\n'
         + '漆面美白：轎車 $2500；大型轎車 $3500；休旅車 $4500\n'
         + '80%無痕拋光：轎車 $4000；大型轎車 $6000；休旅車 $7000\n'
         + '99%無痕拋光：轎車 $6000；大型轎車 $8000；休旅車 $9000';
    quickReplyItems = [
      {
        type: 'action',
        action: { type: 'postback', label: '有什麼區別？', data: 'diff_polishing', displayText: '有什麼區別？' }
      },
      {
        type: 'action',
        action: { type: 'message', label: '返回主選單', text: '返回主選單' }
      }
    ];
  } else if (category === '鍍膜套餐') {
    text = '鍍膜套餐 - 價格表：\n'
         + '鍍膜1年期：轎車 $10000；大型轎車 $12000；休旅車 $13000\n'
         + '鍍膜2年期：轎車 $14000；大型轎車 $16000；休旅車 $17000';
    quickReplyItems = [
      {
        type: 'action',
        action: { type: 'postback', label: '有什麼區別？', data: 'diff_coating', displayText: '有什麼區別？' }
      },
      {
        type: 'action',
        action: { type: 'message', label: '返回主選單', text: '返回主選單' }
      }
    ];
  } else if (category === '全車玻璃鍍膜+除油膜') {
    text = '全車玻璃鍍膜+除油膜 價格：各車型一律 $800';
    quickReplyItems = [
      {
        type: 'action',
        action: { type: 'message', label: '返回主選單', text: '返回主選單' }
      }
    ];
  }
  return {
    type: 'text',
    text: text,
    quickReply: { items: quickReplyItems }
  };
}

// Provide explanation of differences for services in each category
function differenceMessage(categoryKey) {
  let text = '';
  if (categoryKey === 'cleaning') {
    text = '「基礎護理」與「深層護理」有何差別？\n'
         + '基礎護理：一般洗車與基礎清潔，包括車身泡沫清洗、簡單內裝吸塵。\n'
         + '深層護理：除基本清潔外，增加漆面與內裝的深度處理，例如去除鐵粉、柏油及細部內裝清潔等，使車輛潔淨度大幅提升。';
  } else if (categoryKey === 'polishing') {
    text = '各種拋光服務有何不同？\n'
         + '漆面美白：輕度拋光，恢復車漆光澤，去除氧化及淺層污漬，但僅能淡化細微刮痕。\n'
         + '80%無痕拋光：中度拋光，可去除約80%的漆面細紋與淺刮痕，漆面平滑度明顯提升。\n'
         + '99%無痕拋光：多階段精細拋光，可消除約99%的漆面髮絲紋與大部分刮痕，讓漆面幾乎恢復如新。';
  } else if (categoryKey === 'coating') {
    text = '鍍膜1年期與2年期的差別：\n'
         + '鍍膜1年期：單層鍍膜施工，效期約一年，提供基本的漆面保護與光澤。\n'
         + '鍍膜2年期：多層次強化鍍膜，效期約兩年，保護效果更持久。鍍膜可在車漆表面形成保護層，增加亮度與潑水性，讓車漆更易清潔並維持長效光澤。';
  }
  return {
    type: 'text',
    text: text,
    quickReply: {
      items: [
        {
          type: 'action',
          action: { type: 'message', label: '返回主選單', text: '返回主選單' }
        }
      ]
    }
  };
}

// Booking flow: ask for service selection
function bookingAskServiceMessage() {
  return {
    type: 'text',
    text: '請選擇您要預約的服務項目：',
    quickReply: {
      items: [
        { type: 'action', action: { type: 'message', label: '基礎護理', text: '基礎護理' } },
        { type: 'action', action: { type: 'message', label: '深層護理', text: '深層護理' } },
        { type: 'action', action: { type: 'message', label: '漆面美白', text: '漆面美白' } },
        { type: 'action', action: { type: 'message', label: '80%無痕拋光', text: '80%無痕拋光' } },
        { type: 'action', action: { type: 'message', label: '99%無痕拋光', text: '99%無痕拋光' } },
        { type: 'action', action: { type: 'message', label: '鍍膜1年期', text: '鍍膜1年期' } },
        { type: 'action', action: { type: 'message', label: '鍍膜2年期', text: '鍍膜2年期' } },
        { type: 'action', action: { type: 'message', label: '玻璃鍍膜', text: '全車玻璃鍍膜+除油膜' } },
        { type: 'action', action: { type: 'message', label: '返回主選單', text: '返回主選單' } }
      ]
    }
  };
}

// Booking flow: ask for car type
function bookingAskCarTypeMessage(service) {
  return {
    type: 'text',
    text: `服務項目：「${service}」\n請選擇車型：`,
    quickReply: {
      items: [
        { type: 'action', action: { type: 'message', label: '轎車', text: '轎車' } },
        { type: 'action', action: { type: 'message', label: '大型轎車', text: '大型轎車' } },
        { type: 'action', action: { type: 'message', label: '休旅車', text: '休旅車' } },
        { type: 'action', action: { type: 'message', label: '返回主選單', text: '返回主選單' } }
      ]
    }
  };
}

// Booking flow: ask for date/time
function bookingAskDateTimeMessage(service, carType) {
  return {
    type: 'text',
    text: `服務項目：「${service}」、車型：「${carType}」\n請輸入預約日期和時間（例如 2025-01-01 14:00）：`,
    quickReply: {
      items: [
        { type: 'action', action: { type: 'message', label: '返回主選單', text: '返回主選單' } }
      ]
    }
  };
}

// Booking flow: confirmation message
function bookingConfirmMessage(service, carType, datetime) {
  return {
    type: 'text',
    text: `已收到您的預約需求：\n服務項目：${service}\n車型：${carType}\n預約時間：${datetime}\n我們將盡快與您確認預約詳情。`,
    quickReply: {
      items: [
        { type: 'action', action: { type: 'message', label: '返回主選單', text: '返回主選單' } }
      ]
    }
  };
}

// Change-reservation flow: ask for original info
function changeAskInfoMessage() {
  return {
    type: 'text',
    text: '請輸入您原先預約的姓名或電話：',
    quickReply: {
      items: [
        { type: 'action', action: { type: 'message', label: '返回主選單', text: '返回主選單' } }
      ]
    }
  };
}

// Change-reservation flow: confirmation message
function changeConfirmMessage() {
  return {
    type: 'text',
    text: '已收到您的更改請求，將由專人聯繫您確認更改。',
    quickReply: {
      items: [
        { type: 'action', action: { type: 'message', label: '返回主選單', text: '返回主選單' } }
      ]
    }
  };
}

// Handle steps in booking flow
function handleBookingFlow(userId, text, replyToken) {
  const state = userState[userId];
  if (!state || state.flow !== 'booking') return Promise.resolve();

  if (state.step === 1) {
    // Expecting service selection
    const serviceOptions = ['基礎護理', '深層護理', '漆面美白', '80%無痕拋光', '99%無痕拋光', '鍍膜1年期', '鍍膜2年期', '全車玻璃鍍膜+除油膜'];
    if (!serviceOptions.includes(text)) {
      // Invalid response, prompt again
      return client.replyMessage(replyToken, {
        type: 'text',
        text: '請從提供的選項中選擇服務項目。',
        quickReply: bookingAskServiceMessage().quickReply
      });
    }
    // Save selected service and move to next step
    state.data.service = text;
    state.step = 2;
    return client.replyMessage(replyToken, bookingAskCarTypeMessage(text));
  }

  if (state.step === 2) {
    // Expecting car type selection
    const carOptions = ['轎車', '大型轎車', '休旅車'];
    if (!carOptions.includes(text)) {
      return client.replyMessage(replyToken, {
        type: 'text',
        text: '請從提供的選項中選擇車型。',
        quickReply: bookingAskCarTypeMessage(state.data.service).quickReply
      });
    }
    // Save car type and move to next step
    state.data.carType = text;
    state.step = 3;
    return client.replyMessage(replyToken, bookingAskDateTimeMessage(state.data.service, text));
  }

  if (state.step === 3) {
    // Expecting date/time input
    state.data.datetime = text;
    const { service, carType, datetime } = state.data;
    // Clear state
    delete userState[userId];
    // Confirm booking details
    return client.replyMessage(replyToken, bookingConfirmMessage(service, carType, datetime));
  }
}

// Handle step in change-reservation flow
function handleChangeFlow(userId, text, replyToken) {
  const state = userState[userId];
  if (!state || state.flow !== 'change') return Promise.resolve();

  if (state.step === 1) {
    // Received original booking info (name/phone)
    const info = text;  // (This could be used to find the booking in a real system)
    // Clear state and confirm receipt
    delete userState[userId];
    return client.replyMessage(replyToken, changeConfirmMessage());
  }
}

// Start the server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`LINE bot server running on port ${port}`);
});
