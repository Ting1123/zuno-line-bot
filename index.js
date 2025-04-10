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

const sessions = new Map();

const servicePricing = {
  "基礎護理": { "一般轎車": 800, "大型轎車": 1000, "休旅車": 1200 },
  "深層護理": { "一般轎車": 1200, "大型轎車": 1400, "休旅車": 1600 },
  "漆面美白": { "一般轎車": 2500, "大型轎車": 3500, "休旅車": 4500 },
  "80%無痕拋光": { "一般轎車": 4000, "大型轎車": 6000, "休旅車": 7000 },
  "99%無痕拋光": { "一般轎車": 6000, "大型轎車": 9000, "休旅車": 9000 },
  "鍍膜1年期": { "一般轎車": 10000, "大型轎車": 12000, "休旅車": 13000 },
  "鍍膜2年期": { "一般轎車": 14000, "大型轎車": 16000, "休旅車": 17000 },
  "玻璃鍍膜+除油膜": { "一般轎車": 800, "大型轎車": 800, "休旅車": 800 }
};

async function replyMessage(replyToken, messages) {
  try {
    const response = await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        replyToken,
        messages: Array.isArray(messages) ? messages : [{ type: 'text', text: messages }]
      })
    });
    if (!response.ok) {
      console.error('LINE API 回應錯誤:', await response.text());
      // 可根據需求添加重試邏輯或通知管理員
    }
  } catch (error) {
    console.error('發送訊息失敗:', error);
  }
}

function handleUserInput(userId, message, session, replyToken) {
  const { step, data } = session;

  if (message === '我要預約') {
    sessions.set(userId, { step: 'askService', data: {} });
    replyMessage(replyToken, {
      type: 'text',
      text: '請選擇服務項目：',
      quickReply: {
        items: Object.keys(servicePricing).map(service => ({
          type: 'action',
          action: { type: 'message', label: service, text: service }
        }))
      }
    });
    return;
  }

  if (step === 'askService') {
    if (!servicePricing[message]) {
      replyMessage(replyToken, '請從按鈕中選擇有效的服務項目');
      return;
    }
    data.service = message;
    session.step = 'askCarType';
    replyMessage(replyToken, {
      type: 'text',
      text: `請選擇您的車型（如不確定，以下為參考範圍）：
・一般轎車：Altis、Mazda3、Focus...
・大型轎車：Camry、Accord、BMW 5 系列以上
・休旅車：RAV4、CR-V、Outlander、Model X...`
    });
    replyMessage(replyToken, {
      type: 'text',
      text: '請點選您的車型：',
      quickReply: {
        items: ['一般轎車', '大型轎車', '休旅車'].map(label => ({
          type: 'action',
          action: { type: 'message', label, text: label }
        }))
      }
    });
    return;
  }

  if (step === 'askCarType') {
    const validTypes = ['一般轎車', '大型轎車', '休旅車'];
    if (!validTypes.includes(message)) {
      replyMessage(replyToken, '請點選有效的車型按鈕');
      return;
    }
    data.carType = message;
    const price = servicePricing[data.service][message];
    session.step = 'askDate';
    replyMessage(replyToken, `您選擇的是「${data.service}」＋「${message}」，價格為 ${price} 元。\n請輸入預約日期（例如：2025-04-20）`);
    return;
  }

  if (step === 'askDate') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(message)) {
      replyMessage(replyToken, '日期格式錯誤，請輸入類似「2025-04-20」的格式');
      return;
    }
    data.date = message;
    session.step = 'askTime';
    replyMessage(replyToken, {
      type: 'text',
      text: '請選擇預約時段：',
      quickReply: {
        items: ['早上', '下午', '晚上'].map(label => ({
          type: 'action',
          action: { type: 'message', label, text: label }
        }))
      }
    });
    return;
  }

  if (step === 'askTime') {
    const validTimes = ['早上', '下午', '晚上'];
    if (!validTimes.includes(message)) {
      replyMessage(replyToken, '請選擇有效時段：早上／下午／晚上');
      return;
    }
    data.time = message;
    session.step = 'askPhone';
    replyMessage(replyToken, '請輸入聯絡電話（8～12 位數）');
    return;
  }

  if (step === 'askPhone') {
    if (!/^\d{8,12}$/.test(message)) {
      replyMessage(replyToken, '電話號碼格式錯誤，請輸入 8～12 位數字');
      return;
    }
    data.phone = message;
    session.step = 'askLocation';
    replyMessage(replyToken, '請輸入取車地點');
    return;
  }

  if (step === 'askLocation') {
    if (!message.trim()) {
      replyMessage(replyToken, '地點不能為空，請重新輸入');
      return;
    }
    data.location = message;
    session.step = 'confirm';
    const summary = `請確認以下預約資訊：
服務項目：${data.service}
車型：${data.carType}
價格：${servicePricing[data.service][data.carType]} 元
日期：${data.date}
時段：${data.time}
電話：${data.phone}
地點：${data.location}`;
    replyMessage(replyToken, { type: 'text', text: summary });
    replyMessage(replyToken, {
      type: 'template',
      altText: '預約確認',
      template: {
        type: 'confirm',
        text: '是否確認送出這筆預約？',
        actions: [
          { type: 'message', label: '確認送出', text: '確認預約' },
          { type: 'message', label: '重新填寫', text: '重新預約' }
        ]
      }
    });
    return;
  }

  if (step === 'confirm') {
    if (message === '確認預約') {
      replyMessage(replyToken, '✅ 已收到您的預約，我們將盡快與您聯繫！');
      sessions.delete(userId);
      return;
    }
    if (message === '重新預約') {
      sessions.set(userId, { step: 'askService', data: {} });
      replyMessage(replyToken, {
        type: 'text',
        text: '好的，我們重新開始預約，請選擇服務項目：',
        quickReply: {
          items: Object.keys(servicePricing).map(service => ({
            type: 'action',
            action: { type: 'message', label: service, text: service }
          }))
        }
      });
      return;
    }
    replyMessage(replyToken, '請點選「確認送出」或「重新填寫」');
    return;
  }

  // 默認錯誤處理
  replyMessage(replyToken, '請輸入「我要預約」來開始，或繼續當前預約流程');
}

app.post('/webhook', async (req, res) => {
  const events = req.body.events;
  if (!events || events.length === 0) return res.sendStatus(200);

  const event = events[0];
  if (event.type === 'message' && event.message.type === 'text') {
    const userId = event.source.userId;
    const userMessage = event.message.text.trim();

    if (!sessions.has(userId)) {
      sessions.set(userId, { step: 'idle', data: {} });
    }

    const session = sessions.get(userId);
    handleUserInput(userId, userMessage, session, event.replyToken);
  }

  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.send('ZUNO Bot 正在運作中');
});

app.listen(port, () => {
  console.log(`伺服器運行中：http://localhost:${port}`);
});
