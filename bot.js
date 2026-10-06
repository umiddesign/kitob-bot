require('dotenv').config();
const { Bot, InlineKeyboard, Keyboard } = require('grammy');
const { run, sequentialize } = require('@grammyjs/runner');
const http = require('node:http');
const db = require('./database');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);

if (!BOT_TOKEN) {
  console.error("Xatolik: BOT_TOKEN topilmadi! .env faylini tekshiring.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// Bir foydalanuvchining xabarlari ketma-ket, lekin turli foydalanuvchilar parallel ishlashi uchun
bot.use(
  sequentialize((ctx) => {
    const chat = ctx.chat?.id.toString();
    const user = ctx.from?.id.toString();
    return [chat, user].filter(Boolean);
  })
);

// Admin holatlarini saqlash
const adminState = new Map();

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
    .text("➕ Yangi kitob qo'shish").text("🗑 Kitobni o'chirish").row()
    .text("📊 Statistika").text("📢 Xabar tarqatish").row()
    .text("⬅️ Bosh menyu")
    .resized();
}

// Bekor qilish tugmasi
function getCancelKeyboard() {
  return new Keyboard().text("❌ Bekor qilish").text("⏭ O'tkazib yuborish").resized();
}

// Kitob kartasi uchun inline klaviatura
function getBookInlineKeyboard(book) {
  const inline = new InlineKeyboard();
  const hasPdf = Boolean(book.pdf_file_id);
  const hasAudio = Boolean(book.audio_file_id);

  if (hasPdf && hasAudio) {
    inline.text("📄 PDF yuklab olish", `pdf:${book.id}`)
          .text("🎧 Audio tinglash", `audio:${book.id}`)
          .row()
          .text("📦 Ikkalasini ham olish", `both:${book.id}`);
  } else if (hasPdf) {
    inline.text("📄 PDF yuklab olish", `pdf:${book.id}`);
  } else if (hasAudio) {
    inline.text("🎧 Audio tinglash", `audio:${book.id}`);
  }
  return inline;
}

// Kitob matnini chiroyli formatlash
function formatBookCaption(book) {
  let text = `📖 <b>${escapeHtml(book.title)}</b>\n\n`;
  if (book.author) text += `✍️ <b>Muallif:</b> ${escapeHtml(book.author)}\n`;
  text += `🔢 <b>Kitob kodi:</b> <code>${escapeHtml(book.code)}</code>\n`;
  if (book.description) text += `\n📝 <b>Tavsif:</b>\n${escapeHtml(book.description)}\n`;
  
  text += `\n<i>Yuklab olish uchun quyidagi tugmalardan foydalaning:</i>`;
  return text;
}

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Foydalanuvchiga kitobni ko'rsatish
async function sendBookCard(ctx, book) {
  const caption = formatBookCaption(book);
  const keyboard = getBookInlineKeyboard(book);

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

// ==================== FOYDALANUVCHI KOMANDALARI ====================

// /start
bot.command("start", async (ctx) => {
  const user = ctx.from;
  if (user) {
    await db.addUser(user.id, user.username, user.first_name);
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
  const helpText = `ℹ️ <b>Botdan foydalanish bo'yicha qo'llanma:</b>\n\n` +
    `1. Kitobning maxsus <b>kodini</b> yozib yuboring (masalan: <code>101</code>).\n` +
    `2. Bot sizga kitob ma'lumotlarini taqdim etadi.\n` +
    `3. Kerakli formatni tanlang:\n` +
    `   • 📄 <b>PDF yuklab olish</b>\n` +
    `   • 🎧 <b>Audio tinglash</b>\n` +
    `   • 📦 <b>Ikkalasini ham olish</b>\n\n` +
    `<i>Eslatma: Qidiruv faqat kitob kodi orqali ishlaydi.</i>`;

  await ctx.reply(helpText, { parse_mode: "HTML" });
});

// Qidirish tugmasi
bot.hears(["🔍 Kitob kodi orqali qidirish", "🔍 Kitob qidirish"], async (ctx) => {
  await ctx.reply("🔢 Kitob <b>kodini</b> yuboring:\n<i>(Masalan: <code>101</code>)</i>", {
    parse_mode: "HTML"
  });
});

// Bosh menyuga qaytish
bot.hears("⬅️ Bosh menyu", async (ctx) => {
  adminState.delete(ctx.from?.id);
  await ctx.reply("Asosiy menyudasiz:", {
    reply_markup: getMainKeyboard(ctx.from?.id)
  });
});

// ==================== ADMIN PANELI ====================

bot.hears("⚙️ Admin paneli", async (ctx) => {
  if (ctx.from?.id !== ADMIN_ID) {
    return ctx.reply("Kechirasiz, siz admin emassiz.");
  }
  adminState.delete(ctx.from.id);
  await ctx.reply("🛠 <b>Admin paneliga xush kelibsiz!</b>\nKerakli amalni tanlang:", {
    parse_mode: "HTML",
    reply_markup: getAdminKeyboard()
  });
});

// Statistika
bot.hears("📊 Statistika", async (ctx) => {
  if (ctx.from?.id !== ADMIN_ID) return;
  const userCount = await db.getUserCount();
  const bookCount = await db.getTotalBooksCount();

  const statText = `📊 <b>Bot statistikasi:</b>\n\n` +
    `👥 Jami foydalanuvchilar: <b>${userCount} ta</b>\n` +
    `📚 Jami kitoblar: <b>${bookCount} ta</b>`;

  await ctx.reply(statText, { parse_mode: "HTML" });
});

// Kitob o'chirishni boshlash
bot.hears("🗑 Kitobni o'chirish", async (ctx) => {
  if (ctx.from?.id !== ADMIN_ID) return;
  adminState.set(ctx.from.id, { step: "DELETE_CODE" });
  await ctx.reply("O'chirmoqchi bo'lgan kitobingizning <b>kodini</b> kiriting:\n<i>(Masalan: 101)</i>", {
    parse_mode: "HTML",
    reply_markup: new Keyboard().text("❌ Bekor qilish").resized()
  });
});

// Yangi kitob qo'shishni boshlash
bot.hears("➕ Yangi kitob qo'shish", async (ctx) => {
  if (ctx.from?.id !== ADMIN_ID) return;
  adminState.set(ctx.from.id, { step: "ADD_CODE", data: {} });
  await ctx.reply(
    "🆕 <b>Yangi kitob qo'shish:</b>\n\n" +
    "1️⃣ Kitob uchun <b>kod (raqam yoki so'z)</b> kiriting:\n<i>(Masalan: 101 yoki kitob12)</i>",
    {
      parse_mode: "HTML",
      reply_markup: getCancelKeyboard()
    }
  );
});

// Xabar tarqatishni boshlash
bot.hears("📢 Xabar tarqatish", async (ctx) => {
  if (ctx.from?.id !== ADMIN_ID) return;
  adminState.set(ctx.from.id, { step: "BROADCAST" });
  await ctx.reply("Foydalanuvchilarga yubormoqchi bo'lgan xabaringizni yuboring (matn, rasm, video bo'lishi mumkin):", {
    reply_markup: new Keyboard().text("❌ Bekor qilish").resized()
  });
});

// Bekor qilish / O'tkazib yuborish
bot.hears("❌ Bekor qilish", async (ctx) => {
  if (ctx.from?.id === ADMIN_ID) {
    adminState.delete(ctx.from.id);
    await ctx.reply("Amal bekor qilindi.", { reply_markup: getAdminKeyboard() });
  }
});

// ==================== ADMIN STATE HANDLING & SEARCH ====================

bot.on("message", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  // Foydalanuvchini bazaga qo'shish
  await db.addUser(userId, ctx.from.username, ctx.from.first_name);

  // Admin bosqichlarini tekshirish
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
          // Telegram rate limitini buzmaslik uchun kichik kechikish
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

    // 3. Kitob qo'shish qadamma-qadam
    // Qadam 1: Kod
    if (state.step === "ADD_CODE") {
      if (!text) return ctx.reply("Iltimos, kodni yozib yuboring:");
      const exists = await db.bookCodeExists(text);
      if (exists) {
        return ctx.reply(`❌ Bu kod (<code>${escapeHtml(text)}</code>) band! Boshqa kod kiriting:`, { parse_mode: "HTML" });
      }
      state.data.code = text;
      state.step = "ADD_TITLE";
      await ctx.reply("2️⃣ Kitob <b>nomini</b> kiriting:\n<i>(Masalan: O'tkan kunlar)</i>", {
        parse_mode: "HTML",
        reply_markup: getCancelKeyboard()
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
        return ctx.reply("Iltimos, rasm yuboring yoki '⏭ O'tkazib yuborish' tugmasini bosing:");
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
      await ctx.reply("7️⃣ Kitobning <b>Audio faylini (Audio yoki Ovoz)</b> yuboring (yoki '⏭ O'tkazib yuborish'):", {
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

      await ctx.reply("🎉 <b>Kitob muvaffaqiyatli saqlandi!</b>\nQuyida qanday ko'rinishda chiqishi keltirilgan:", {
        parse_mode: "HTML",
        reply_markup: getAdminKeyboard()
      });

      if (savedBook) {
        await sendBookCard(ctx, savedBook);
      }
      return;
    }
  }

  // Foydalanuvchi matn yuborganda — FAQAT KOD bo'yicha qidiruv
  const code = ctx.message.text?.trim();
  if (!code) return;

  const bookByCode = await db.getBookByCode(code);
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

  // PDF yuklab olish
  if (data.startsWith("pdf:")) {
    const bookId = Number(data.split(":")[1]);
    const book = await db.getBookById(bookId);
    if (!book || !book.pdf_file_id) {
      await ctx.answerCallbackQuery({ text: "PDF fayli mavjud emas!", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: "PDF yuklanmoqda..." });
    await ctx.replyWithDocument(book.pdf_file_id, {
      caption: `📄 <b>${escapeHtml(book.title)}</b> (PDF nusxa)`,
      parse_mode: "HTML"
    });
    return;
  }

  // Audio tinglash
  if (data.startsWith("audio:")) {
    const bookId = Number(data.split(":")[1]);
    const book = await db.getBookById(bookId);
    if (!book || !book.audio_file_id) {
      await ctx.answerCallbackQuery({ text: "Audio fayli mavjud emas!", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Audio yuklanmoqda..." });
    await ctx.replyWithAudio(book.audio_file_id, {
      caption: `🎧 <b>${escapeHtml(book.title)}</b> (Audio kitob)`,
      parse_mode: "HTML"
    });
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
    await ctx.answerCallbackQuery({ text: "Fayllar yuborilmoqda..." });

    if (book.pdf_file_id) {
      await ctx.replyWithDocument(book.pdf_file_id, {
        caption: `📄 <b>${escapeHtml(book.title)}</b> (PDF nusxa)`,
        parse_mode: "HTML"
      });
    }

    if (book.audio_file_id) {
      await ctx.replyWithAudio(book.audio_file_id, {
        caption: `🎧 <b>${escapeHtml(book.title)}</b> (Audio kitob)`,
        parse_mode: "HTML"
      });
    }
    return;
  }

  await ctx.answerCallbackQuery();
});

// Xatoliklarni ushlash va botni to'xtamasligini ta'minlash (Auto-recovery)
bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`Xatolik yuz berdi (${ctx?.update?.update_id}):`, err.error);
});

// Render / Railway uchun HTTP Health-Check serveri
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Bot ajoyib tarzda 24/7 ishlamoqda!');
}).listen(PORT, () => {
  console.log(`🌐 Health-check serveri ${PORT}-portda ishlamoqda`);
});

// Asosiy ishga tushirish funksiyasi
async function startApp() {
  try {
    await db.initDB();
    console.log("🚀 Ma'lumotlar bazasi tayyor.");

    // Runner bilan parallel ko'p oqimli ishga tushirish
    const runner = run(bot, {
      runner: {
        fetch: {
          allowed_updates: ["message", "callback_query"],
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
