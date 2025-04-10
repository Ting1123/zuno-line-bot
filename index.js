const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
const port = process.env.PORT || 3000;
const accessToken = process.env.LINE_ACCESS_TOKEN;

app.use(bodyParser.json());

app.get('/', (req, res) => {
  res.send('ZUNO Bot 正在運行中');
});

app.post('/webhook', async (req, res) => {
  const events = req.body.events;
  if (!events || events.length === 0) {
    return res.sendStatus(200);
  }

  const event = events[0];
  if (event.type === 'message' && event.message.type === 'text') {
    const replyToken = event.replyToken;
    const userMessage = event.message.text;

    const replyMessage = {
      replyToken: replyToken,
      messages: [{
        type: 'text',
        text: `你說的是：「${userMessage}」`
      }]
    };

    try {
      const response = await fetch('https://api.line.me/v2/bot/message/reply', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify(replyMessage)
      });

      if (!response.ok) {
        console.error('LINE 回應失敗：', await response.text());
      }
    } catch (error) {
      console.error('發送訊息錯誤：', error);
    }
  }

  res.sendStatus(200);
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
