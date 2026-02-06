import { VK, Keyboard } from "vk-io";
import admin from "firebase-admin";
import fetch from "node-fetch";
import http from "http";

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
console.log("🚀 Бот запущен");

// =======================
// КНОПКИ (Исправлено: invalid event_id)
// =======================
vk.updates.on("message_event", async (ctx) => {
  // Важно: сразу извлекаем данные
  const payload = ctx.eventPayload;
  if (!payload?.reportId) return;

  try {
    const { reportId, action } = payload;
    const snap = await db.ref(`reports/${reportId}`).once("value");
    const report = snap.val();

    if (!report || report.status !== "pending") {
      return ctx.answer({ type: "show_snackbar", text: "⚠ Уже обработано" });
    }

    const [adminUser] = await vk.api.users.get({ user_ids: ctx.userId });
    const adminName = `${adminUser.first_name} ${adminUser.last_name}`;
    const approved = action === "ok";

    await db.ref(`reports/${reportId}`).update({
      status: approved ? "approved" : "rejected",
      checker: adminName
    });

    // Редактируем сообщение
    await vk.api.messages.edit({
      peer_id: ctx.peerId,
      conversation_message_id: ctx.conversationMessageId,
      message: 
        `${report.vkText || "Отчет"}\n\n` +
        `${approved ? "✅ ОДОБРЕНО" : "❌ ОТКЛОНЕНО"}\n` +
        `👤 Администратор: ${adminName}`,
      keyboard: Keyboard.builder().inline().toString()
    });

    // Отвечаем ВК, что событие обработано
    await ctx.answer({ type: "show_snackbar", text: "Готово!" });

  } catch (e) {
    console.error("❌ Ошибка кнопки:", e);
    // В случае ошибки просто закрываем "загрузку" на кнопке у пользователя
    try { await ctx.answer(); } catch (err) {}
  }
});

// =======================
// ОТЧЕТЫ И ФОТО (Исправлено: random_id и загрузка)
// =======================
db.ref("reports").on("child_added", async (snap) => {
  const reportId = snap.key;
  const report = snap.val();

  if (report.vkMessageId) return;

  const peerIdSnap = await db.ref("settings/chatPeerId").once("value");
  const peerId = peerIdSnap.val();
  if (!peerId) return;

  const text =
    `📝 НОВЫЙ ОТЧЕТ\n\n` +
    `👤 Ник: ${report.author || "—"}\n` +
    `🔰 Должность: ${report.role || "—"}\n` +
    `📅 Дата: ${report.date || "—"}\n\n` +
    `🛠 Работа: ${report.work || "—"}\n` +
    `⚖️ Наказания: ${report.punishments || "—"}\n` +
    `📊 Баллы: ${report.score || 0}`;

  const attachments = [];
  const photoUrls = report.photos ? Object.values(report.photos) : [];

  // Загрузка фотографий
  for (const url of photoUrls) {
    if (typeof url !== 'string') continue;
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      
      const buffer = Buffer.from(await response.arrayBuffer());
      
      // Загружаем как фото в сообщения
      const photo = await vk.upload.messagePhoto({
        source: { value: buffer }
      });
      attachments.push(photo.toString());
      console.log(`✅ Фото загружено: ${photo.toString()}`);
    } catch (e) {
      console.error(`❌ Ошибка загрузки фото:`, e.message);
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
      // ИСПРАВЛЕНО: random_id теперь всегда целое число
      random_id: Math.floor(Math.random() * 2147483647), 
      message: text,
      attachment: attachments,
      keyboard: keyboard.toString()
    });

    await db.ref(`reports/${reportId}`).update({
      vkMessageId: msgId,
      vkText: text,
      status: "pending"
    });
  } catch (err) {
    console.error("❌ Ошибка при отправке сообщения в VK:", err);
  }
});

// Прочие команды
vk.updates.on("message_new", async (ctx) => {
    if (ctx.isOutbox || !ctx.text) return;
    if (ctx.text === "/bind") {
        await db.ref("settings/chatPeerId").set(ctx.peerId);
        return ctx.send(`✅ Чат привязан к ID: ${ctx.peerId}`);
    }
});

vk.updates.start().catch(console.error);
http.createServer((_, res) => res.end("OK")).listen(process.env.PORT || 3000);
