require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenAI } = require('@google/genai');

const { TELEGRAM_BOT_TOKEN, GEMINI_API_KEY, MINI_APP_URL } = process.env;

if (!TELEGRAM_BOT_TOKEN || !GEMINI_API_KEY) {
  console.error('Missing env vars: TELEGRAM_BOT_TOKEN, GEMINI_API_KEY');
  process.exit(1);
}

// ---- Dummy HTTP server (Render port binding) ----
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running'));
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.listen(PORT, () => console.log(`HTTP server listening on port ${PORT}`));

// ---- Gemini ----
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

// ---- Telegram ----
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

bot.onText(/^\/start/, async (msg) => {
  try {
    const text = 'မင်္ဂလာပါ! 👋 ကြိုဆိုပါတယ်။ မေးခွန်းတစ်ခုခု ရိုက်ပို့ပါ၊ AI က ဖြေပေးပါမယ်။';
    const options = MINI_APP_URL
      ? { reply_markup: { inline_keyboard: [[{ text: '🚀 Mini App ဖွင့်မည်', web_app: { url: MINI_APP_URL } }]] } }
      : {};
    await bot.sendMessage(msg.chat.id, text, options);
  } catch (err) {
    console.error('/start error:', err.message);
  }
});

bot.on('message', async (msg) => {
  const text = msg.text;
  if (!text || text.startsWith('/')) return;

  const chatId = msg.chat.id;
  try {
    bot.sendChatAction(chatId, 'typing').catch(() => {});
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: text,
    });
    const reply = (response && response.text) || 'အဖြေ မရရှိပါ။ ခဏနေမှ ပြန်စမ်းကြည့်ပေးပါ။';
    // Telegram limit is 4096 chars per message
    for (let i = 0; i < reply.length; i += 4000) {
      await bot.sendMessage(chatId, reply.slice(i, i + 4000));
    }
  } catch (err) {
    console.error('Gemini error:', err.status || '', err.message);
    try {
      const base = 'ခဏနေမှ ပြန်စမ်းကြည့်ပေးပါ 🙏';
      const debug = process.env.DEBUG === 'true' ? `\n\n[DEBUG] ${String(err.message).slice(0, 500)}` : '';
      await bot.sendMessage(chatId, base + debug);
    } catch (e) {
      console.error('Send error:', e.message);
    }
  }
});

bot.on('polling_error', (err) => console.error('Polling error:', err.message));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));
