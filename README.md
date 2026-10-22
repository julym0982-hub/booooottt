# Telegram AI Bot (Gemini + Groq fallback)

Gemini ကို အရင်သုံးပြီး quota ကုန် (429) ရင် Groq ကို အလိုအလျောက် ပြောင်းသုံးပါတယ်။
Quota ကုန်ထားတဲ့ provider ကို cooldown အတွင်း ထပ်မခေါ်တော့ဘဲ ကျော်သွားပါတယ်။

- Build Command: npm install
- Start Command: node index.js
- Env Vars: TELEGRAM_BOT_TOKEN, GEMINI_API_KEY, GROQ_API_KEY, MINI_APP_URL (optional)
- Optional: GEMINI_MODEL, GEMINI_FALLBACK_MODEL, GROQ_MODEL, DEBUG
- Gemini မသုံးချင်ရင် GEMINI_API_KEY ကို မထည့်ဘဲ GROQ_API_KEY တစ်ခုတည်း သုံးလို့ရပါတယ်။
- အလုပ်လုပ်ပုံ: business.txt ထဲက အချက်အလက်ပေါ်မူတည်ပြီး customer မေးခွန်းကို ဖြေပါတယ်။
