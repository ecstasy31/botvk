import { VK, Keyboard } from "vk-io";
import admin from "firebase-admin";
import fetch from "node-fetch";
import http from "http";

// =======================
// ИНИЦИАЛИЗАЦИЯ
// =======================
const vk = new VK({
  token: process.env.VK_TOKEN,
  apiVersion: "5.199",
  pollingGroupId: Number(process.env.VK_GROUP_ID)
});

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
    databaseURL: "https://modersekb-default-rtdb.firebaseio.com"
  });
}

const db = admin.database();
const botStartTime = Date.now(); // Фиксируем время запуска для фильтрации старых отчетов
console.log("🚀 Бот запущен. Старые отчеты игнорируются.");

// =======================
// КОМАНДЫ (BIND, ID, INFO)
// =======================
vk.updates.on("message_new", async (ctx) => {
  if (ctx.isOutbox || !ctx.text) return;
  const text = ctx.text.trim();

  if (text === "/bind") {
    await db.ref("settings/chatPeerId").set(ctx.peerId);
    return ctx.send(`✅ Беседа привязана к peer_id: ${ctx.peerId}`);
  }

  if (text === "/id") {
    return ctx.send(`peer_id: ${ctx.peerId}`);
  }

  if (text.startsWith("/info")) {
    const nick = text.replace("/info", "").trim();
    if (!nick) return ctx.send("❗ Используй: /info Ник");

    const usersSnap = await db.ref("users").once("value");
    const reportsSnap = await db.ref("reports").once("value");
    
    const users = usersSnap.val() || {};
    const reports = reportsSnap.val() || {};

    const userEntry = Object.values(users).find(u => (u.nickname || "").toLowerCase() === nick.toLowerCase());
    const userReports = Object.values(reports).filter(r => (r.author || "").toLowerCase() === nick.toLowerCase());

    if (!userEntry && userReports.length === 0) return ctx.send("❌ Модератор не найден");

    const lastReport = userReports.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))[0];
    const avgScore = userReports.length ? Math.round(userReports.reduce((s, r) => s + Number(r.score || 0), 0) / userReports.length) : 0;

    return ctx.send(
      `📋 ИНФОРМАЦИЯ О МОДЕРАТОРЕ\n\n` +
      `👤 Ник: ${nick}\n` +
      `📧 Почта: ${userEntry?.email || "не привязана"}\n` + // ДОБАВИЛИ ПОЧТУ
      `🎖 Роль: ${userEntry?.role || lastReport?.role || "не указана"}\n` +
      `🟢 Статус: ${userEntry?.active ? "активен" : "неактивен"}\n\n` +
      `📊 Баллы: ${userEntry?.score || 0}\n` +
      `📝 Отчетов: ${userReports.length}\n` +
      `📅 Последний отчет: ${lastReport?.date || "нет"}\n` +
      `📈 Средний балл: ${avgScore}`
    );
  }
});

// =======================
// КНОПКИ (ИСПРАВЛЕНИЕ ОШИБОК)
// =======================
vk.updates.on("message_event", async (ctx) => {
  try {
    const payload = ctx.eventPayload;
    if (!payload?.reportId) return;

    // Сразу отвечаем ВК, чтобы убрать "загрузку" на кнопке и избежать invalid event_id
    await ctx.answer().catch(() => {});

    const { reportId, action } = payload;
    const snap = await db.ref(`reports/${reportId}`).once("value");
    const report = snap.val();

    if (!report || report.status !== "pending") {
      return vk.api.messages.send({ 
        peer_id: ctx.peerId, 
        message: "⚠ Этот отчет уже был обработан.", 
        random_id: Math.floor(Date.now() * Math.random()) 
      });
    }

    const [adminUser] = await vk.api.users.get({ user_ids: ctx.userId });
    const adminName = `${adminUser.first_name} ${adminUser.last_name}`;
    const approved = action === "ok";

    await db.ref(`reports/${reportId}`).update({
      status: approved ? "approved" : "rejected",
      checker: adminName
    });

    await vk.api.messages.edit({
      peer_id: ctx.peerId,
      conversation_message_id: ctx.conversationMessageId,
      message: `${report.vkText}\n\n${approved ? "✅ ОДОБРЕНО" : "❌ ОТКЛОНЕНО"}\n👤 Администратор: ${adminName}`,
      keyboard: Keyboard.builder().inline().toString()
    });

  } catch (e) {
    console.error("❌ Ошибка кнопок:", e);
  }
});

// =======================
// ОТЧЕТЫ (ИСПРАВЛЕНИЕ ФОТО И random_id)
// =======================
db.ref("reports").on("child_added", async (snap) => {
  const report = snap.val();
  const reportId = snap.key;

  // ИСПРАВЛЕНИЕ: Не отправляем старые отчеты при перезагрузке
  // Проверяем либо дату создания, либо наличие статуса 'pending'
  if (report.vkMessageId || report.status) return;
  
  // Дополнительная проверка на время (если отчет создан раньше, чем запущен бот - скипаем)
  // В Firebase обычно даты хранятся в report.timestamp или report.date
  // Если их нет, можно просто полагаться на флаг vkMessageId.

  const peerIdSnap = await db.ref("settings/chatPeerId").once("value");
  const peerId = peerIdSnap.val();
  if (!peerId) return;

  const text =
    `📝 НОВЫЙ ОТЧЕТ\n\n` +
    `👤 Ник: ${report.author}\n` +
    `🔰 Должность: ${report.role}\n` +
    `📅 Дата: ${report.date}\n\n` +
    `🛠 Работа: ${report.work}\n` +
    `⚖️ Наказания: ${report.punishments}\n` +
    `📊 Баллы: ${report.score}`;

  const attachments = [];
  const photos = report.photos ? Object.values(report.photos) : [];

  // ИСПРАВЛЕНИЕ ЗАГРУЗКИ ФОТО
  for (const url of photos) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Fetch failed: ${r.statusText}`);
      
      const buffer = Buffer.from(await r.arrayBuffer());
      const photo = await vk.upload.messagePhoto({
        source: { value: buffer }
      });
      attachments.push(photo.toString());
    } catch (e) {
      console.error("❌ Ошибка загрузки фото:", e.message);
    }
  }

  const keyboard = Keyboard.builder()
    .inline()
    .callbackButton({
      label: "✅ Одобрить",
      payload: { reportId, action: "ok" },
      color: "positive"
    })
    .callbackButton({
      label: "❌ Отказать",
      payload: { reportId, action: "no" },
      color: "negative"
    });

  try {
    const msgId = await vk.api.messages.send({
      peer_id: Number(peerId),
      // ИСПРАВЛЕНИЕ: random_id теперь строго целое число (int64)
      random_id: Math.floor(Date.now() + Math.random() * 1000), 
      message: text,
      attachment: attachments,
      keyboard: keyboard.toString()
    });

    await db.ref(`reports/${reportId}`).update({
      vkMessageId: msgId,
      vkText: text,
      status: "pending"
    });
    console.log(`✅ Отчет ${reportId} отправлен`);
  } catch (err) {
    console.error("❌ Ошибка VK API:", err.message);
  }
});

// =======================
vk.updates.start().catch(console.error);
http.createServer((_, res) => res.end("Bot Work")).listen(process.env.PORT || 3000);
