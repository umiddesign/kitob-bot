require('dotenv').config();
const { Bot, InlineKeyboard, Keyboard } = require('grammy');
const { run, sequentialize } = require('@grammyjs/runner');
const http = require('node:http');
const db = require('./database');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const REQUIRED_CHANNELS = [
  { 
    id: '@audio_pdfkitoblari', 
    url: 'https://t.me/audio_pdfkitoblari', 
    name: 'Kitoblar olami (Audio & PDF)' 
  }
];

if (!BOT_TOKEN) {
  console.error("Xatolik: BOT_TOKEN topilmadi! .env faylini tekshiring.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// Majburiy obuna klaviaturasi
function getSubKeyboard(unsubscribedChannels, startPayload = "") {
  const keyboard = new InlineKeyboard();
  const list = unsubscribedChannels && unsubscribedChannels.length > 0 ? unsubscribedChannels : REQUIRED_CHANNELS;
  if (list.length === 1) {
    keyboard.url("📢 Kanalga a'zo bo'lish", list[0].url).row();
  } else {
    list.forEach((ch, idx) => {
      keyboard.url(`📢 ${idx + 1}-kanalga a'zo bo'lish`, ch.url).row();
    });
  }
  const callbackData = startPayload ? `check_sub:${startPayload}` : "check_sub";
  keyboard.text("✅ Obunani tekshirish", callbackData);
  return keyboard;
}

// A'zo bo'linmagan kanallarni aniqlash
async function getUnsubscribedChannels(api, userId) {
  if (userId === ADMIN_ID) return [];
  const unsubscribed = [];

  for (const ch of REQUIRED_CHANNELS) {
    let isSub = false;

    // 1. Agar foydalanuvchi ushbu kanalga so'rov (join request) yuborgan bo'lsa
    const hasReq = await db.hasJoinRequest(userId, ch.id || ch.url);
    if (hasReq) {
      isSub = true;
    } else if (ch.id) {
      try {
        const member = await api.getChatMember(ch.id, userId);
        isSub = ["creator", "administrator", "member", "restricted"].includes(member.status);
      } catch (err) {
        isSub = false;
      }
    }

    if (!isSub) {
      unsubscribed.push(ch);
    }
  }

  return unsubscribed;
}

// Obunani tekshirish funksiyasi
async function isUserSubscribed(api, userId) {
  const unsubscribed = await getUnsubscribedChannels(api, userId);
  return unsubscribed.length === 0;
}

// Obuna bo'lish haqida xabar
async function sendSubPrompt(ctx, unsubscribed = REQUIRED_CHANNELS, startPayload = "") {
  let subText = `⚠️ <b>Botdan foydalanish uchun rasmiy kanalimizga a'zo bo'lishingiz shart:</b>\n\n`;
  if (unsubscribed.length === 1) {
    subText += `👉 <a href="${unsubscribed[0].url}"><b>${escapeHtml(unsubscribed[0].name)}</b></a>\n`;
  } else {
    unsubscribed.forEach((ch, idx) => {
      subText += `${idx + 1}. 👉 <a href="${ch.url}">${escapeHtml(ch.name)}</a>\n`;
    });
  }
  subText += `\nIltimos, kanalga a'zo bo'ling va so'ng pastdagi <b>"✅ Obunani tekshirish"</b> tugmasini bosing:`;

  await ctx.reply(subText, {
    parse_mode: "HTML",
    reply_markup: getSubKeyboard(unsubscribed, startPayload),
    link_preview_options: { is_disabled: true }
  });
}

// Bir foydalanuvchining xabarlari ketma-ket, lekin turli foydalanuvchilar parallel ishlashi uchun
bot.use(
  sequentialize((ctx) => {
    const chat = ctx.chat?.id.toString();
    const user = ctx.from?.id.toString();
    return [chat, user].filter(Boolean);
  })
);

// Majburiy obunani tekshiruvchi global middleware
bot.use(async (ctx, next) => {
  // Kanal yoki guruh ichidagi xabarlarga javob bermaslik (faqat shaxsiy chatda ishlash)
  if (ctx.chat && ctx.chat.type !== "private") {
    return next();
  }

  const userId = ctx.from?.id;
  if (!userId) return next();

  // Foydalanuvchini bazaga kiritish
  await db.addUser(userId, ctx.from.username, ctx.from.first_name);

  // Admin har doim cheklovlarsiz o'tadi
  if (userId === ADMIN_ID) {
    return next();
  }

  // Agar "Obunani tekshirish" tugmasi bosilgan bo'lsa, o'tkazish
  if (ctx.callbackQuery?.data?.startsWith("check_sub")) {
    return next();
  }

  // Obuna holatini tekshirish
  const unsubscribed = await getUnsubscribedChannels(ctx.api, userId);
  if (unsubscribed.length > 0) {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({
        text: "❌ Botdan foydalanish uchun rasmiy kanalimizga a'zo bo'ling!",
        show_alert: true
      });
    } else {
      let startPayload = "";
      const msgText = ctx.message?.text?.trim() || "";
      if (msgText.startsWith("/start ")) {
        startPayload = msgText.slice(7).trim();
      }
      await sendSubPrompt(ctx, unsubscribed, startPayload);
    }
    return;
  }

  return next();
});

// Admin holatlarini saqlash
const adminState = new Map();

// Fayl ID'larni massiv sifatida o'qish (1 ta yoki ko'p qismli audio/pdf uchun)
function parseFileIds(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  const str = String(raw).trim();
  if (!str) return [];
  if (str.startsWith("[")) {
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) return parsed.filter(Boolean);
    } catch (_) {}
  }
  return [str];
}

// Asosiy menyu klaviaturasi
function getMainKeyboard(userId) {
  const keyboard = new Keyboard()
    .text("🔍 Kitob kodi orqali qidirish").text("ℹ️ Yordam");
  
  if (userId === ADMIN_ID) {
    keyboard.row().text("⚙️ Admin paneli");
  }
  return keyboard.resized();
}

// Admin menyu klaviaturasi
function getAdminKeyboard() {
  return new Keyboard()
    .text("➕ Yangi kitob qo'shish").text("📚 Kitoblar ro'yxati").row()
    .text("🗑 Kitobni o'chirish").text("📊 Statistika").row()
    .text("📢 Xabar tarqatish").text("⬅️ Bosh menyu")
    .resized();
}

// Bekor qilish tugmasi
function getCancelKeyboard() {
  return new Keyboard().text("❌ Bekor qilish").text("⏭ O'tkazib yuborish").resized();
}

// Kitob kartasi uchun inline klaviatura
function getBookInlineKeyboard(book, isAdmin = false) {
  const inline = new InlineKeyboard();
  const pdfList = parseFileIds(book.pdf_file_id);
  const audioList = parseFileIds(book.audio_file_id);
  const hasPdf = pdfList.length > 0;
  const hasAudio = audioList.length > 0;
  const audioBtnText = audioList.length > 1 ? `🎧 Audio (${audioList.length} qism)` : "🎧 Audio tinglash";

  if (hasPdf && hasAudio) {
    inline.text("📄 PDF yuklab olish", `pdf:${book.id}`)
          .text(audioBtnText, `audio:${book.id}`)
          .row()
          .text("📦 Ikkalasini ham olish", `both:${book.id}`);
  } else if (hasPdf) {
    inline.text("📄 PDF yuklab olish", `pdf:${book.id}`);
  } else if (hasAudio) {
    inline.text(audioBtnText, `audio:${book.id}`);
  }

  if (isAdmin) {
    inline.row()
      .text("➕ Audio qism qo'shish", `add_audio:${book.id}`)
      .text("📢 Kanalga chiqarish", `pub_ch:${book.id}`);
  }

  return inline;
}

// Kitob matnini chiroyli formatlash
function formatBookCaption(book) {
  const pdfList = parseFileIds(book.pdf_file_id);
  const audioList = parseFileIds(book.audio_file_id);

  let formatParts = [];
  if (pdfList.length > 0) formatParts.push("PDF 📄");
  if (audioList.length > 0) {
    formatParts.push(audioList.length > 1 ? `Audio (${audioList.length} qism) 🎧` : "Audio 🎧");
  }

  let text = `📖 <b>${escapeHtml(book.title)}</b>\n\n`;
  if (book.author) text += `✍️ <b>Muallif:</b> ${escapeHtml(book.author)}\n`;
  if (formatParts.length > 0) text += `📂 <b>Format:</b> ${formatParts.join(" + ")}\n`;
  text += `🔢 <b>Kitob kodi:</b> <code>${escapeHtml(book.code)}</code>\n`;
  if (book.description) text += `\n📝 <b>Tavsif:</b>\n${escapeHtml(book.description)}\n`;
  
  text += `\n👇 <i>Yuklab olish uchun quyidagi tugmalardan foydalaning:</i>`;
  return text;
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Foydalanuvchiga kitobni ko'rsatish
async function sendBookCard(ctx, book) {
  const caption = formatBookCaption(book);
  const isAdmin = ctx.from?.id === ADMIN_ID;
  const keyboard = getBookInlineKeyboard(book, isAdmin);

  if (book.cover_file_id) {
    try {
      await ctx.replyWithPhoto(book.cover_file_id, {
        caption,
        parse_mode: "HTML",
        reply_markup: keyboard
      });
      return;
    } catch (err) {
      console.error("Muqovani yuborishda xatolik:", err.message);
    }
  }

  await ctx.reply(caption, {
    parse_mode: "HTML",
    reply_markup: keyboard
  });
}

// PDF faylni xavfsiz va chiroyli yuborish
async function sendBookPdf(ctx, book) {
  const pdfList = parseFileIds(book.pdf_file_id);
  for (let i = 0; i < pdfList.length; i++) {
    const partLabel = pdfList.length > 1 ? ` (${i + 1}-qism)` : "";
    const caption =
      `📄 <b>${escapeHtml(book.title)}</b>${partLabel}\n` +
      (book.author ? `✍️ <b>Muallif:</b> ${escapeHtml(book.author)}\n` : "") +
      `🔢 <b>Kitob kodi:</b> <code>${escapeHtml(book.code)}</code>\n\n` +
      `🤖 <b>Botimiz:</b> @pdf_audio_kitoblarbot\n` +
      `📢 <b>Kanalimiz:</b> @audio_pdfkitoblari`;

    await ctx.replyWithDocument(pdfList[i], {
      caption,
      parse_mode: "HTML"
    });
  }
}

// Audio faylni xavfsiz va chiroyli yuborish (Audio / Voice / Document fallback bilan)
async function sendBookAudio(ctx, book) {
  const audioList = parseFileIds(book.audio_file_id);
  for (let i = 0; i < audioList.length; i++) {
    const fileId = audioList[i];
    const partLabel = audioList.length > 1 ? ` (${i + 1}-qism)` : "";
    const caption =
      `🎧 <b>${escapeHtml(book.title)}</b>${partLabel}\n` +
      (book.author ? `✍️ <b>Muallif:</b> ${escapeHtml(book.author)}\n` : "") +
      `🔢 <b>Kitob kodi:</b> <code>${escapeHtml(book.code)}</code>\n\n` +
      `🤖 <b>Botimiz:</b> @pdf_audio_kitoblarbot\n` +
      `📢 <b>Kanalimiz:</b> @audio_pdfkitoblari`;

    try {
      await ctx.replyWithAudio(fileId, { caption, parse_mode: "HTML" });
    } catch (_) {
      try {
        await ctx.replyWithVoice(fileId, { caption, parse_mode: "HTML" });
      } catch (__) {
        await ctx.replyWithDocument(fileId, { caption, parse_mode: "HTML" });
      }
    }
  }
}

// Kanalga kitob e'lonini (rasmi + yuklab olish tugmasi bilan) avtomatik chiqarish
async function publishBookToChannel(api, book, botUsername = "pdf_audio_kitoblarbot") {
  const targetChannel = REQUIRED_CHANNELS[0]?.id || "@audio_pdfkitoblari";
  const pdfList = parseFileIds(book.pdf_file_id);
  const audioList = parseFileIds(book.audio_file_id);
  const hasPdf = pdfList.length > 0;
  const hasAudio = audioList.length > 0;

  let formatLabel = "PDF + Audio 🎧";
  let btnLabel = "📥 Kitobni yuklab olish (PDF + Audio)";
  if (hasPdf && !hasAudio) {
    formatLabel = "PDF 📄";
    btnLabel = "📥 Kitobni yuklab olish (PDF)";
  } else if (!hasPdf && hasAudio) {
    formatLabel = "Audio kitob 🎧";
    btnLabel = "🎧 Audio kitobni tinglash";
  }

  let postText = `📚 <b>${escapeHtml(book.title)}</b>\n\n`;
  if (book.author) postText += `✍️ <b>Muallif:</b> ${escapeHtml(book.author)}\n`;
  postText += `📄 <b>Format:</b> ${formatLabel}\n`;
  postText += `🔢 <b>Kitob kodi:</b> <code>${escapeHtml(book.code)}</code>\n`;
  if (book.description) postText += `\n📝 <b>Kitob haqida:</b>\n${escapeHtml(book.description)}\n`;
  postText += `\n👇 <i>Kitobni yuklab olish uchun quyidagi tugmani bosing:</i>`;

  const isCleanCode = /^[A-Za-z0-9_-]{1,50}$/.test(book.code);
  const startParam = isCleanCode ? `book_${book.code}` : `id_${book.id}`;
  const deepLink = `https://t.me/${botUsername}?start=${startParam}`;

  const inlineKeyboard = new InlineKeyboard().url(btnLabel, deepLink);

  if (book.cover_file_id) {
    await api.sendPhoto(targetChannel, book.cover_file_id, {
      caption: postText,
      parse_mode: "HTML",
      reply_markup: inlineKeyboard
    });
  } else {
    await api.sendMessage(targetChannel, postText, {
      parse_mode: "HTML",
      reply_markup: inlineKeyboard
    });
  }
}

// Deep-link payload orqali kitobni topish
async function resolveBookFromPayload(payload) {
  if (!payload) return null;
  const clean = payload.trim();
  if (clean.startsWith("id_")) {
    const id = Number(clean.slice(3));
    if (!Number.isNaN(id)) return await db.getBookById(id);
  }
  if (clean.startsWith("book_")) {
    const codeOrId = clean.slice(5);
    const byCode = await db.getBookByCode(codeOrId);
    if (byCode) return byCode;
    const id = Number(codeOrId);
    if (!Number.isNaN(id)) return await db.getBookById(id);
  }
  return await db.getBookByCode(clean);
}

// Foydalanuvchi yozgan matndan kodni aqlli ajratib olish (masalan: "#101", "kod 101", "101")
async function findBookSmart(rawText) {
  if (!rawText) return null;
  const trimmed = rawText.trim();
  let book = await db.getBookByCode(trimmed);
  if (book) return book;

  const cleaned = trimmed
    .replace(/^#/i, "")
    .replace(/^kitob\s*kodi\s*:?\s*/i, "")
    .replace(/^kod\s*:?\s*/i, "")
    .replace(/\s*-?\s*kitob$/i, "")
    .trim();

  if (cleaned && cleaned !== trimmed) {
    book = await db.getBookByCode(cleaned);
  }
  return book;
}

// ==================== FOYDALANUVCHI KOMANDALARI ====================

// /start
bot.command("start", async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  const user = ctx.from;
  if (!user) return;

  adminState.delete(user.id);
  await db.addUser(user.id, user.username, user.first_name);

  const payload = typeof ctx.match === "string" ? ctx.match.trim() : "";

  // Majburiy obunani tekshirish
  const isSub = await isUserSubscribed(ctx.api, user.id);
  if (!isSub) {
    const unsubscribed = await getUnsubscribedChannels(ctx.api, user.id);
    await sendSubPrompt(ctx, unsubscribed, payload);
    return;
  }

  // Agar kanaldan "Kitobni yuklab olish" tugmasini bosib kirgan bo'lsa
  if (payload) {
    const book = await resolveBookFromPayload(payload);
    if (book) {
      await sendBookCard(ctx, book);
      return;
    }
  }

  const welcomeText = `Assalomu alaykum, <b>${escapeHtml(ctx.from?.first_name || 'Foydalanuvchi')}</b>!\n\n` +
    `📚 <b>Kitoblar olamiga xush kelibsiz!</b>\n\n` +
    `Ushbu bot orqali siz kerakli kitoblarning <b>PDF elektron nusxasini</b> hamda <b>Audio formatini</b> bir joydan olishingiz mumkin.\n\n` +
    `🔢 <b>Kitobni olish uchun:</b>\n` +
    `Shunchaki kitobning <b>kodini</b> yuboring (masalan: <code>101</code>).\n\n` +
    `Kerakli bo'limni tanlang:`;

  await ctx.reply(welcomeText, {
    parse_mode: "HTML",
    reply_markup: getMainKeyboard(ctx.from?.id)
  });
});

// Yordam
bot.hears("ℹ️ Yordam", async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  const helpText = `ℹ️ <b>Botdan foydalanish bo'yicha qo'llanma:</b>\n\n` +
    `1. Kitobning maxsus <b>kodini</b> yozib yuboring (masalan: <code>101</code>).\n` +
    `2. Bot sizga kitob ma'lumotlarini taqdim etadi.\n` +
    `3. Kerakli formatni tanlang:\n` +
    `   • 📄 <b>PDF yuklab olish</b>\n` +
    `   • 🎧 <b>Audio tinglash</b>\n` +
    `   • 📦 <b>Ikkalasini ham olish</b>\n\n` +
    `📢 <b>Rasmiy kanalimiz:</b> @audio_pdfkitoblari`;

  await ctx.reply(helpText, { parse_mode: "HTML" });
});

// Qidirish tugmasi
bot.hears(["🔍 Kitob kodi orqali qidirish", "🔍 Kitob qidirish"], async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  await ctx.reply("🔢 Kitob <b>kodini</b> yuboring:\n<i>(Masalan: <code>101</code>)</i>", {
    parse_mode: "HTML"
  });
});

// Bosh menyuga qaytish
bot.hears("⬅️ Bosh menyu", async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  adminState.delete(ctx.from?.id);
  await ctx.reply("Asosiy menyudasiz:", {
    reply_markup: getMainKeyboard(ctx.from?.id)
  });
});

// ==================== ADMIN PANELI ====================

bot.hears("⚙️ Admin paneli", async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  if (ctx.from?.id !== ADMIN_ID) {
    return ctx.reply("Kechirasiz, siz admin emassiz.");
  }
  adminState.delete(ctx.from.id);
  await ctx.reply("🛠 <b>Admin paneliga xush kelibsiz!</b>\nKerakli amalni tanlang:", {
    parse_mode: "HTML",
    reply_markup: getAdminKeyboard()
  });
});

// Admin uchun barcha kitoblar ro'yxati
bot.hears("📚 Kitoblar ro'yxati", async (ctx) => {
  if (ctx.chat?.type !== "private" || ctx.from?.id !== ADMIN_ID) return;
  const books = await db.getAllBooks(50, 0);
  if (!books || books.length === 0) {
    return ctx.reply("📭 Hozircha bazada kitoblar yo'q.", { reply_markup: getAdminKeyboard() });
  }

  let listText = `📚 <b>Bazadagi barcha kitoblar (${books.length} ta):</b>\n\n`;
  const kb = new InlineKeyboard();

  books.forEach((b, idx) => {
    const pdfCount = parseFileIds(b.pdf_file_id).length;
    const audioCount = parseFileIds(b.audio_file_id).length;
    const badges = [
      pdfCount > 0 ? "📄" : "",
      audioCount > 0 ? (audioCount > 1 ? `🎧x${audioCount}` : "🎧") : ""
    ].filter(Boolean).join("");

    listText += `${idx + 1}. <b>Kod:</b> <code>${escapeHtml(b.code)}</code> — <b>${escapeHtml(b.title)}</b> ${badges}\n`;
    kb.text(`📖 #${b.code} ${b.title.slice(0, 18)}`, `view_book:${b.id}`);
    if ((idx + 1) % 2 === 0) kb.row();
  });

  listText += `\n<i>Kitobni ko'rish, kanalga chiqarish yoki audio qism qo'shish uchun pastdagi tugmasini bosing:</i>`;

  await ctx.reply(listText, {
    parse_mode: "HTML",
    reply_markup: kb
  });
});

// Statistika
bot.hears("📊 Statistika", async (ctx) => {
  if (ctx.chat?.type !== "private" || ctx.from?.id !== ADMIN_ID) return;
  const userCount = await db.getUserCount();
  const bookCount = await db.getTotalBooksCount();

  const statText = `📊 <b>Bot statistikasi:</b>\n\n` +
    `👥 Jami foydalanuvchilar: <b>${userCount} ta</b>\n` +
    `📚 Jami kitoblar: <b>${bookCount} ta</b>\n` +
    `☁️ Doimiy bulutli zaxira: <b>Yoqilgan (Faol) ✅</b>`;

  await ctx.reply(statText, { parse_mode: "HTML" });
});

// Kitob o'chirishni boshlash
bot.hears("🗑 Kitobni o'chirish", async (ctx) => {
  if (ctx.chat?.type !== "private" || ctx.from?.id !== ADMIN_ID) return;
  adminState.set(ctx.from.id, { step: "DELETE_CODE" });
  await ctx.reply("O'chirmoqchi bo'lgan kitobingizning <b>kodini</b> kiriting:\n<i>(Masalan: 101)</i>", {
    parse_mode: "HTML",
    reply_markup: new Keyboard().text("❌ Bekor qilish").resized()
  });
});

// Yangi kitob qo'shishni boshlash
bot.hears("➕ Yangi kitob qo'shish", async (ctx) => {
  if (ctx.chat?.type !== "private" || ctx.from?.id !== ADMIN_ID) return;
  adminState.set(ctx.from.id, { step: "ADD_CODE", data: {} });
  await ctx.reply(
    "🆕 <b>Yangi kitob qo'shish:</b>\n\n" +
    "1️⃣ Kitob uchun <b>kod (raqam yoki so'z)</b> kiriting:\n<i>(Masalan: 101)</i>",
    {
      parse_mode: "HTML",
      reply_markup: new Keyboard().text("❌ Bekor qilish").resized()
    }
  );
});

// Xabar tarqatishni boshlash
bot.hears("📢 Xabar tarqatish", async (ctx) => {
  if (ctx.chat?.type !== "private" || ctx.from?.id !== ADMIN_ID) return;
  adminState.set(ctx.from.id, { step: "BROADCAST" });
  await ctx.reply("Foydalanuvchilarga yubormoqchi bo'lgan xabaringizni yuboring (matn, rasm, video bo'lishi mumkin):", {
    reply_markup: new Keyboard().text("❌ Bekor qilish").resized()
  });
});

// Bekor qilish
bot.hears("❌ Bekor qilish", async (ctx) => {
  if (ctx.chat?.type === "private" && ctx.from?.id === ADMIN_ID) {
    adminState.delete(ctx.from.id);
    await ctx.reply("❌ Amal bekor qilindi.", { reply_markup: getAdminKeyboard() });
  }
});

// Qo'shilish so'rovi (Zayavka / Join Request) kelganda
bot.on("chat_join_request", async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  console.log(`📥 Yangi zayavka (Join Request): Foydalanuvchi ${userId} -> Kanal ${chatId}`);

  await db.addJoinRequest(userId, String(chatId));
});

// Bot kanalga qo'shilganda
bot.on("my_chat_member", async (ctx) => {
  console.log(`Bot kanalga qo'shildi/o'zgardi: ${ctx.chat.title} (ID: ${ctx.chat.id})`);
});

// ==================== ADMIN STATE HANDLING & SEARCH ====================

bot.on("message", async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  const userId = ctx.from?.id;
  if (!userId) return;

  // Foydalanuvchini bazaga qo'shish
  await db.addUser(userId, ctx.from.username, ctx.from.first_name);

  // Admin bosqichlarini tekshirish (Forward qilingan fayllar ham qabul qilinishi uchun birinchi tekshiriladi!)
  if (userId === ADMIN_ID && adminState.has(userId)) {
    const state = adminState.get(userId);
    const text = ctx.message.text?.trim();
    const isSkip = text === "⏭ O'tkazib yuborish" || text === "/skip";

    // 1. O'chirish
    if (state.step === "DELETE_CODE") {
      if (!text) return ctx.reply("Iltimos, kitob kodini matn ko'rinishida yuboring.");
      const success = await db.deleteBookByCode(text);
      adminState.delete(userId);
      if (success) {
        await ctx.reply(`✅ <code>${escapeHtml(text)}</code> kodli kitob muvaffaqiyatli o'chirildi!`, {
          parse_mode: "HTML",
          reply_markup: getAdminKeyboard()
        });
      } else {
        await ctx.reply(`❌ <code>${escapeHtml(text)}</code> kodli kitob topilmadi.`, {
          parse_mode: "HTML",
          reply_markup: getAdminKeyboard()
        });
      }
      return;
    }

    // 2. Xabar tarqatish (Broadcast)
    if (state.step === "BROADCAST") {
      adminState.delete(userId);
      const userIds = await db.getAllUserIds();
      await ctx.reply(`🚀 Xabar ${userIds.length} ta foydalanuvchiga yuborilmoqda...`);

      let sentCount = 0;
      let blockedCount = 0;

      for (const id of userIds) {
        try {
          await ctx.copyMessage(id);
          sentCount++;
          await new Promise(r => setTimeout(r, 40));
        } catch (_) {
          blockedCount++;
        }
      }

      await ctx.reply(
        `✅ <b>Xabar tarqatish yakunlandi!</b>\n\n` +
        `Yuborildi: <b>${sentCount} ta</b>\n` +
        `Yetib bormadi (bloklagan): <b>${blockedCount} ta</b>`,
        { parse_mode: "HTML", reply_markup: getAdminKeyboard() }
      );
      return;
    }

    // 3. Mavjud kitobga qo'shimcha audio qism qo'shish
    if (state.step === "APPEND_AUDIO") {
      const book = await db.getBookById(state.bookId);
      if (!book) {
        adminState.delete(userId);
        return ctx.reply("❌ Kitob topilmadi.", { reply_markup: getAdminKeyboard() });
      }

      if (text === "✅ Tugatish va saqlash") {
        adminState.delete(userId);
        await ctx.reply("✅ Barcha audio qismlar saqlandi!", { reply_markup: getAdminKeyboard() });
        await sendBookCard(ctx, book);
        return;
      }

      let newAudioId = null;
      if (ctx.message.audio) newAudioId = ctx.message.audio.file_id;
      else if (ctx.message.voice) newAudioId = ctx.message.voice.file_id;
      else if (ctx.message.document) newAudioId = ctx.message.document.file_id;

      if (!newAudioId) {
        return ctx.reply("Iltimos, audio fayl yuboring yoki yakunlash uchun <b>'✅ Tugatish va saqlash'</b> tugmasini bosing:", {
          parse_mode: "HTML"
        });
      }

      const currentAudios = parseFileIds(book.audio_file_id);
      currentAudios.push(newAudioId);
      const serialized = currentAudios.length === 1 ? currentAudios[0] : JSON.stringify(currentAudios);

      await db.addBook({
        code: book.code,
        title: book.title,
        author: book.author,
        description: book.description,
        cover_file_id: book.cover_file_id,
        pdf_file_id: book.pdf_file_id,
        audio_file_id: serialized
      });

      await ctx.reply(
        `✅ <b>${currentAudios.length}-audio qism qo'shildi!</b>\n\nYana keyingi audio qismini yuborishingiz mumkin yoki tugatish uchun pastdagi <b>"✅ Tugatish va saqlash"</b> tugmasini bosing:`,
        {
          parse_mode: "HTML",
          reply_markup: new Keyboard().text("✅ Tugatish va saqlash").text("❌ Bekor qilish").resized()
        }
      );
      return;
    }

    // 4. Kitob qo'shish qadamma-qadam
    // Qadam 1: Kod
    if (state.step === "ADD_CODE") {
      if (!text) return ctx.reply("Iltimos, kodni yozib yuboring:");
      const exists = await db.bookCodeExists(text);
      if (exists) {
        return ctx.reply(`❌ Bu kod (<code>${escapeHtml(text)}</code>) band! Boshqa kod kiriting (yoki avval eskisini o'chiring):`, { parse_mode: "HTML" });
      }
      state.data.code = text;
      state.step = "ADD_TITLE";
      await ctx.reply("2️⃣ Kitob <b>nomini</b> kiriting:\n<i>(Masalan: O'tkan kunlar)</i>", {
        parse_mode: "HTML",
        reply_markup: new Keyboard().text("❌ Bekor qilish").resized()
      });
      return;
    }

    // Qadam 2: Nomi
    if (state.step === "ADD_TITLE") {
      if (!text) return ctx.reply("Iltimos, kitob nomini yozing:");
      state.data.title = text;
      state.step = "ADD_AUTHOR";
      await ctx.reply("3️⃣ Kitob <b>muallifini</b> kiriting (yoki '⏭ O'tkazib yuborish' tugmasini bosing):\n<i>(Masalan: Abdulla Qodiriy)</i>", {
        parse_mode: "HTML",
        reply_markup: getCancelKeyboard()
      });
      return;
    }

    // Qadam 3: Muallifi
    if (state.step === "ADD_AUTHOR") {
      state.data.author = isSkip ? null : text;
      state.step = "ADD_DESCRIPTION";
      await ctx.reply("4️⃣ Kitob haqida <b>qisqacha tavsif / annotatsiya</b> kiriting (yoki '⏭ O'tkazib yuborish'):", {
        parse_mode: "HTML",
        reply_markup: getCancelKeyboard()
      });
      return;
    }

    // Qadam 4: Tavsif
    if (state.step === "ADD_DESCRIPTION") {
      state.data.description = isSkip ? null : text;
      state.step = "ADD_COVER";
      await ctx.reply("5️⃣ Kitob <b>muqovasi rasmini (Photo)</b> yuboring (yoki '⏭ O'tkazib yuborish'):", {
        parse_mode: "HTML",
        reply_markup: getCancelKeyboard()
      });
      return;
    }

    // Qadam 5: Muqova rasmi
    if (state.step === "ADD_COVER") {
      if (ctx.message.photo && ctx.message.photo.length > 0) {
        state.data.cover_file_id = ctx.message.photo[ctx.message.photo.length - 1].file_id;
      } else if (!isSkip) {
        return ctx.reply("Iltimos, muqova uchun oddiy rasm (Photo) yuboring yoki '⏭ O'tkazib yuborish' tugmasini bosing:");
      }
      state.step = "ADD_PDF";
      await ctx.reply("6️⃣ Kitobning <b>PDF hujjat faylini (Document)</b> yuboring (yoki '⏭ O'tkazib yuborish'):", {
        parse_mode: "HTML",
        reply_markup: getCancelKeyboard()
      });
      return;
    }

    // Qadam 6: PDF fayl
    if (state.step === "ADD_PDF") {
      if (ctx.message.document) {
        state.data.pdf_file_id = ctx.message.document.file_id;
      } else if (!isSkip) {
        return ctx.reply("Iltimos, PDF faylni hujjat ko'rinishida yuboring yoki '⏭ O'tkazib yuborish' tugmasini bosing:");
      }
      state.step = "ADD_AUDIO";
      await ctx.reply("7️⃣ Kitobning <b>Audio faylini (MP3 / Audio / Ovoz)</b> yuboring (yoki '⏭ O'tkazib yuborish'):", {
        parse_mode: "HTML",
        reply_markup: getCancelKeyboard()
      });
      return;
    }

    // Qadam 7: Audio fayl
    if (state.step === "ADD_AUDIO") {
      if (ctx.message.audio) {
        state.data.audio_file_id = ctx.message.audio.file_id;
      } else if (ctx.message.voice) {
        state.data.audio_file_id = ctx.message.voice.file_id;
      } else if (ctx.message.document) {
        state.data.audio_file_id = ctx.message.document.file_id;
      } else if (!isSkip) {
        return ctx.reply("Iltimos, audio fayl yuboring yoki '⏭ O'tkazib yuborish' tugmasini bosing:");
      }

      if (!state.data.pdf_file_id && !state.data.audio_file_id) {
        return ctx.reply("⚠️ Kitobda kamida PDF yoki Audio fayl bo'lishi kerak! Iltimos, Audio fayl yuboring:");
      }

      // Bazaga saqlash
      await db.addBook({
        code: state.data.code,
        title: state.data.title,
        author: state.data.author,
        description: state.data.description,
        cover_file_id: state.data.cover_file_id,
        pdf_file_id: state.data.pdf_file_id,
        audio_file_id: state.data.audio_file_id
      });

      const savedBook = await db.getBookByCode(state.data.code);
      adminState.delete(userId);

      let channelStatus = "\n📢 <b>@audio_pdfkitoblari kanaliga avtomatik e'lon joylandi!</b>";
      if (savedBook) {
        try {
          await publishBookToChannel(ctx.api, savedBook, ctx.me?.username || "pdf_audio_kitoblarbot");
        } catch (err) {
          console.error("Kanalga post chiqarishda xatolik:", err.message);
          channelStatus = `\n⚠️ <i>Kanalga chiqarishda xatolik: ${escapeHtml(err.message)}</i>`;
        }
      }

      await ctx.reply(
        `🎉 <b>Kitob muvaffaqiyatli saqlandi!</b>${channelStatus}\n\nQuyida bot ichida qanday ko'rinishda chiqishi keltirilgan (agar kitobning yana boshqa audio qismlari bo'lsa, pastdagi <b>"➕ Audio qism qo'shish"</b> tugmasini bosishingiz mumkin):`,
        {
          parse_mode: "HTML",
          reply_markup: getAdminKeyboard()
        }
      );

      if (savedBook) {
        await sendBookCard(ctx, savedBook);
      }
      return;
    }
  }

  // Agar admin (kitob qo'shishdan tashqari paytda) biror kanaldan xabarni forward qilsa, kanal ID'sini ko'rsatish
  if (userId === ADMIN_ID && (ctx.message.forward_origin || ctx.message.forward_from_chat)) {
    const fChat = ctx.message.forward_origin?.chat || ctx.message.forward_from_chat;
    if (fChat) {
      await ctx.reply(
        `📢 <b>Kanal aniqlandi!</b>\n\n` +
        `Nomi: <b>${escapeHtml(fChat.title || 'Nomsiz')}</b>\n` +
        `ID raqami: <code>${fChat.id}</code>`,
        { parse_mode: "HTML" }
      );
      return;
    }
  }

  // Foydalanuvchi matn yuborganda — KOD bo'yicha aqlli qidiruv
  const code = ctx.message.text?.trim();
  if (!code) return;

  const bookByCode = await findBookSmart(code);
  if (bookByCode) {
    await sendBookCard(ctx, bookByCode);
    return;
  }

  // Topilmaganda:
  await ctx.reply(
    `❌ Kechirasiz, <code>${escapeHtml(code)}</code> kodli kitob topilmadi.\n\n` +
    `💡 <i>Iltimos, kitob kodini to'g'ri kiritganingizga ishonch hosil qiling (Masalan: <code>101</code>).</i>`,
    { parse_mode: "HTML" }
  );
});

// ==================== INLINE CALLBACK HANDLERS ====================

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;

  if (data === "noop") {
    await ctx.answerCallbackQuery();
    return;
  }

  // Obunani tekshirish tugmasi
  if (data.startsWith("check_sub")) {
    const userId = ctx.from.id;
    const startPayload = data.includes(":") ? data.slice(data.indexOf(":") + 1) : "";
    const unsubscribed = await getUnsubscribedChannels(ctx.api, userId);
    if (unsubscribed.length === 0) {
      await ctx.answerCallbackQuery({ text: "✅ Rahmat! Kanalga obuna tasdiqlandi." });
      try {
        await ctx.deleteMessage();
      } catch (_) {}

      if (startPayload) {
        const book = await resolveBookFromPayload(startPayload);
        if (book) {
          await ctx.reply("✅ Obuna tasdiqlandi! Marhamat, siz so'ragan kitob:", {
            reply_markup: getMainKeyboard(userId)
          });
          await sendBookCard(ctx, book);
          return;
        }
      }

      const welcomeText = `Assalomu alaykum, <b>${escapeHtml(ctx.from?.first_name || 'Foydalanuvchi')}</b>!\n\n` +
        `📚 <b>Kitoblar olamiga xush kelibsiz!</b>\n\n` +
        `Ushbu bot orqali siz kerakli kitoblarning <b>PDF elektron nusxasini</b> hamda <b>Audio formatini</b> bir joydan olishingiz mumkin.\n\n` +
        `🔢 <b>Kitobni olish uchun:</b>\n` +
        `Shunchaki kitobning <b>kodini</b> yuboring (masalan: <code>101</code>).\n\n` +
        `Kerakli bo'limni tanlang:`;

      await ctx.reply(welcomeText, {
        parse_mode: "HTML",
        reply_markup: getMainKeyboard(userId)
      });
    } else {
      await ctx.answerCallbackQuery({
        text: `❌ Siz hali rasmiy kanalimizga a'zo bo'lmadingiz!`,
        show_alert: true
      });
    }
    return;
  }

  // Admin: Kitobni ro'yxatdan ko'rish
  if (data.startsWith("view_book:")) {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCallbackQuery();
    const bookId = Number(data.split(":")[1]);
    const book = await db.getBookById(bookId);
    if (!book) {
      return ctx.answerCallbackQuery({ text: "Kitob topilmadi!", show_alert: true });
    }
    await ctx.answerCallbackQuery();
    await sendBookCard(ctx, book);
    return;
  }

  // Admin: Kitobni kanalga chiqarish
  if (data.startsWith("pub_ch:")) {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCallbackQuery();
    const bookId = Number(data.split(":")[1]);
    const book = await db.getBookById(bookId);
    if (!book) {
      return ctx.answerCallbackQuery({ text: "Kitob topilmadi!", show_alert: true });
    }
    try {
      await publishBookToChannel(ctx.api, book, ctx.me?.username || "pdf_audio_kitoblarbot");
      await ctx.answerCallbackQuery({ text: "✅ @audio_pdfkitoblari kanaliga joylandi!", show_alert: true });
    } catch (err) {
      await ctx.answerCallbackQuery({ text: `❌ Xatolik: ${err.message}`, show_alert: true });
    }
    return;
  }

  // Admin: Mavjud kitobga yana audio qism qo'shish
  if (data.startsWith("add_audio:")) {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCallbackQuery();
    const bookId = Number(data.split(":")[1]);
    const book = await db.getBookById(bookId);
    if (!book) {
      return ctx.answerCallbackQuery({ text: "Kitob topilmadi!", show_alert: true });
    }
    adminState.set(ctx.from.id, { step: "APPEND_AUDIO", bookId });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `🎧 <b>"${escapeHtml(book.title)}"</b> kitobiga qo'shimcha audio qism qo'shish:\n\n` +
      `Yangi audio faylni (yoki bir nechta audio fayllarni ketma-ket) yuboring. Tugatgach <b>"✅ Tugatish va saqlash"</b> tugmasini bosing:`,
      {
        parse_mode: "HTML",
        reply_markup: new Keyboard().text("✅ Tugatish va saqlash").text("❌ Bekor qilish").resized()
      }
    );
    return;
  }

  // PDF yuklab olish
  if (data.startsWith("pdf:")) {
    const bookId = Number(data.split(":")[1]);
    const book = await db.getBookById(bookId);
    if (!book || parseFileIds(book.pdf_file_id).length === 0) {
      await ctx.answerCallbackQuery({ text: "PDF fayli mavjud emas!", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: "📄 PDF yuborilmoqda..." });
    await sendBookPdf(ctx, book);
    return;
  }

  // Audio tinglash
  if (data.startsWith("audio:")) {
    const bookId = Number(data.split(":")[1]);
    const book = await db.getBookById(bookId);
    if (!book || parseFileIds(book.audio_file_id).length === 0) {
      await ctx.answerCallbackQuery({ text: "Audio fayli mavjud emas!", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: "🎧 Audio yuborilmoqda..." });
    await sendBookAudio(ctx, book);
    return;
  }

  // Ikkalasini ham olish
  if (data.startsWith("both:")) {
    const bookId = Number(data.split(":")[1]);
    const book = await db.getBookById(bookId);
    if (!book) {
      await ctx.answerCallbackQuery({ text: "Kitob topilmadi!", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: "📦 Fayllar yuborilmoqda..." });
    await sendBookPdf(ctx, book);
    await sendBookAudio(ctx, book);
    return;
  }

  await ctx.answerCallbackQuery();
});

// Xatoliklarni ushlash va botni to'xtamasligini ta'minlash (Auto-recovery)
bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`Xatolik yuz berdi (${ctx?.update?.update_id}):`, err.error);
});

// HTTP Health-Check serveri (Render/Railway uchun, agar PORT berilsa)
if (process.env.PORT) {
  const PORT = process.env.PORT;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bot ajoyib tarzda 24/7 ishlamoqda!');
  });
  server.on('error', (err) => {
    console.log('HTTP port ogohlantirishi (bot ishlashda davom etadi):', err.message);
  });
  server.listen(PORT, () => {
    console.log(`🌐 Health-check serveri ${PORT}-portda ishlamoqda`);
  });
}

// Asosiy ishga tushirish funksiyasi
async function startApp() {
  try {
    await db.initDB();
    console.log("🚀 Ma'lumotlar bazasi tayyor.");

    // Runner bilan parallel ko'p oqimli ishga tushirish
    const runner = run(bot, {
      runner: {
        fetch: {
          allowed_updates: ["message", "callback_query", "chat_join_request", "my_chat_member"],
        },
      },
    });

    console.log("⚡ Bot parallel High-Load rejimida ishga tushirildi!");

    // Graceful shutdown
    const stopRunner = () => runner.isRunning() && runner.stop();
    process.once("SIGINT", stopRunner);
    process.once("SIGTERM", stopRunner);
  } catch (err) {
    console.error("Ishga tushirishda xatolik:", err);
  }
}

startApp();
