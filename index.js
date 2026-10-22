require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenAI } = require('@google/genai');

const { TELEGRAM_BOT_TOKEN, GEMINI_API_KEY, MINI_APP_URL } = process.env;

if (!TELEGRAM_BOT_TOKEN || (!GEMINI_API_KEY && !process.env.GROQ_API_KEY)) {
  console.error('Missing env vars: TELEGRAM_BOT_TOKEN and at least one of GEMINI_API_KEY / GROQ_API_KEY');
  process.exit(1);
}

// ---- Dummy HTTP server (Render port binding) ----
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running'));
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.listen(PORT, () => console.log(`HTTP server listening on port ${PORT}`));

// ---- Gemini ----
const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

const fs = require('fs');
const path = require('path');

function loadBusinessInfo() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'business.txt'), 'utf8');
    return raw
      .split('\n')
      .filter((l) => !l.trim().startsWith('# '))
      .join('\n')
      .trim();
  } catch (e) {
    console.warn('business.txt not found, using generic assistant');
    return '';
  }
}

const BUSINESS_INFO = loadBusinessInfo();

const SYSTEM_INSTRUCTION = `You are a friendly, polite customer service assistant for the business described below, chatting with customers on Telegram.

Rules:
- Reply in the same language the customer writes in. If they write in Burmese (Myanmar), reply in natural, polite Burmese.
- Answer ONLY using the business information below. Never invent prices, policies, stock, delivery times or contact details.
- If the answer is not in the business information, say you are not sure and politely refer the customer to the contact details given below.
- Keep replies short, clear and helpful (a few sentences). Use simple formatting; do not use markdown symbols like ** or ##.
- If the customer is upset, apologize briefly and offer to connect them with a human via the contact details.
- Do not discuss topics unrelated to this business; politely steer back.

=== BUSINESS INFORMATION ===
${BUSINESS_INFO || '(No business information provided yet. Be a general helpful assistant.)'}
=== END ===`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Provider chain: Gemini -> Groq ----
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || '';

const errCode = (err) => err && (err.status || err.code);
const isRetryable = (err) => [500, 503, 504].includes(errCode(err));

// quota ပြည့်ထားတဲ့ provider ကို cooldown ကာလအတွင်း ထပ်မခေါ်ဘဲ ကျော်မယ် (request မဖြုန်းအောင်)
const cooldownUntil = {};
const inCooldown = (key) => (cooldownUntil[key] || 0) > Date.now();
function startCooldown(key, err, fallbackMs) {
  let ms = fallbackMs;
  const m = String(err && err.message).match(/"retryDelay":"(\d+)s"/);
  if (m) ms = Number(m[1]) * 1000;
  ms = Math.min(Math.max(ms, 60 * 1000), 6 * 60 * 60 * 1000); // 1 min .. 6 hours
  cooldownUntil[key] = Date.now() + ms;
  console.warn(`[${key}] cooling down for ${Math.round(ms / 60000)} min`);
}

async function callGeminiModel(model, text) {
  const key = `gemini:${model}`;
  if (inCooldown(key)) throw Object.assign(new Error('cooldown'), { skipped: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: text,
        config: { systemInstruction: SYSTEM_INSTRUCTION },
      });
      const out = response && response.text;
      if (!out) throw new Error('Empty Gemini response');
      return out;
    } catch (err) {
      console.error(`Gemini error [${model}] attempt ${attempt + 1}:`, errCode(err) || '', String(err.message).slice(0, 200));
      if (errCode(err) === 429) {
        startCooldown(key, err, 30 * 60 * 1000);
        throw err; // 429 ကို retry မလုပ်ဘူး
      }
      if (!isRetryable(err) || attempt === 2) throw err;
      await sleep(1500 * (attempt + 1));
    }
  }
}

async function callGroq(text) {
  if (!GROQ_API_KEY) throw Object.assign(new Error('GROQ_API_KEY not set'), { skipped: true });
  const key = 'groq';
  if (inCooldown(key)) throw Object.assign(new Error('cooldown'), { skipped: true });
  const body = {
    model: GROQ_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_INSTRUCTION },
      { role: 'user', content: text },
    ],
    temperature: 0.4,
    max_completion_tokens: 2048,
  };
  if (GROQ_MODEL.includes('gpt-oss')) body.reasoning_effort = 'low';

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      const out = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!out) throw new Error('Empty Groq response');
      return out.trim();
    }
    const errText = (await res.text()).slice(0, 300);
    console.error(`Groq error [${GROQ_MODEL}] attempt ${attempt + 1}:`, res.status, errText);
    const err = Object.assign(new Error(`Groq ${res.status}: ${errText}`), { status: res.status });
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || 60;
      // တစ်မိနစ်ထက်နည်းရင် ခဏစောင့်ပြီး ၁ ခါပဲ ထပ်စမ်း၊ မဟုတ်ရင် cooldown
      if (retryAfter <= 5 && attempt === 0) { await sleep(retryAfter * 1000); continue; }
      startCooldown(key, err, retryAfter * 1000);
      throw err;
    }
    if (!isRetryable(err) || attempt === 1) throw err;
    await sleep(1500);
  }
}

// Gemini -> (Gemini backup model) -> Groq ဆက်တိုက် စမ်းမယ်
async function askAI(text) {
  const steps = [];
  if (GEMINI_API_KEY) {
    steps.push({ name: `gemini:${MODEL}`, run: () => callGeminiModel(MODEL, text) });
    if (GEMINI_FALLBACK_MODEL && GEMINI_FALLBACK_MODEL !== MODEL) {
      steps.push({ name: `gemini:${GEMINI_FALLBACK_MODEL}`, run: () => callGeminiModel(GEMINI_FALLBACK_MODEL, text) });
    }
  }
  if (GROQ_API_KEY) steps.push({ name: `groq:${GROQ_MODEL}`, run: () => callGroq(text) });

  let lastErr = new Error('No AI provider configured');
  for (const step of steps) {
    try {
      return await step.run();
    } catch (err) {
      if (!err.skipped) lastErr = err;
      else if (!lastErr.status) lastErr = err;
    }
  }
  throw lastErr;
}

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
    const reply = (await askAI(text)) || 'အဖြေ မရရှိပါ။ ခဏနေမှ ပြန်စမ်းကြည့်ပေးပါ။';
    // Telegram limit is 4096 chars per message
    for (let i = 0; i < reply.length; i += 4000) {
      await bot.sendMessage(chatId, reply.slice(i, i + 4000));
    }
  } catch (err) {
    console.error('AI error (all providers failed):', err.status || '', err.message);
    try {
      const code = err && (err.status || err.code);
      const base = code === 429
        ? 'လက်ရှိ AI အသုံးပြုမှု များနေပါတယ်။ ခဏနေမှ ပြန်စမ်းကြည့်ပေးပါ 🙏'
        : 'ခဏနေမှ ပြန်စမ်းကြည့်ပေးပါ 🙏';
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
