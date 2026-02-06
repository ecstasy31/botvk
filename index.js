import { VK, Keyboard } from "vk-io";
import admin from "firebase-admin";
import fetch from "node-fetch";
import http from "http";

// =======================
// VK Инициализация
// =======================
const vk = new VK({
  token: process.env.VK_TOKEN,
  apiVersion: "5.199",
  pollingGroupId: Number(process.env.VK_GROUP_ID)
});

// =======================
// FIREBASE Инициализация
// =======================
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
    databaseURL: "https://modersekb-default-rtdb.firebaseio.com"
  });
}

const db = admin.database();
console.log("🚀 Бот запущен и готов к работе");

// =======================
// ОБРАБОТКА КОМАНД (message_new)
// =======================
vk.updates.on("message_new", async (ctx) => {
  if (ctx.isOutbox) return;
  const text = ctx.text?.trim();
  if (!text) return;

  if (text === "/bind") {
    await db.ref("settings/chatPeerId").set(ctx.peerId);
    return ctx.send(`✅ Беседа привязана\npeer_id: ${ctx.peerId}`);
  }

  if (text === "/id") {
    return ctx.send(`peer_id: ${ctx.peerId}`);
  }

  if (text.startsWith("/info")) {
    const nick = text.replace("/info", "").trim();
    if (!nick) return ctx.send("❗ Используй: /info Ник");

    const [usersSnap, reportsSnap] = await Promise.all([
      db.ref("users").once("value"),
      db.ref("reports").once("value")
    ]);

    const users = usersSnap.val() || {};
    const reports = reportsSnap.val() || {};

    const userFromUsers = Object.values(users).find(
      u => (u.nickname || "").toLowerCase() === nick.toLowerCase()
    );

    const userReports = Object.values(reports).filter(
      r => (r.author || "").toLowerCase() === nick.toLowerCase()
    );

    if (!userFromUsers && userReports.length === 0) {
      return ctx.send("❌ Модератор не найден");
    }

    const lastReport = userReports.sort(
      (a, b) => new Date(b.date || 0) - new Date(a.date || 0)
    )[0];

    const avgScore = userReports.length
      ? Math.round(userReports.reduce((s, r) => s + Number(r.score || 0), 0) / userReports.length)
      : 0;

    return ctx.send(
      `📋 ИНФОРМАЦИЯ О МОДЕРАТОРЕ\n\n` +
      `👤 Ник: ${nick}\n` +
      `🎖 Роль: ${userFromUsers?.role || lastReport?.role || "не указана"}\n` +
      `🟢 Статус: ${userFromUsers?.active ? "активен" : "неактивен"}\n\n` +
      `📊 Баллы: ${userFromUsers?.score || 0}\n` +
      `📝 Отчетов: ${userReports.length}\n` +
      `📅 Последний отчет: ${lastReport?.date || "нет"}\n` +
      `📈 Средний балл: ${avgScore}`
    );
  }
});

// =======================
// ОБРАБОТКА КНОПОК (message_event)
// =======================
vk.updates.on("message_event", async (ctx) => {
  try {
    // VK-IO автоматически парсит payload, если он пришел как JSON
    const payload = typeof ctx.eventPayload === "string" 
      ? JSON.parse(ctx.eventPayload) 
      : ctx.eventPayload;

    if (!payload?.reportId) return;

    const { reportId, action } = payload;
    const snap = await db.ref(`reports/${reportId}`).once("value");
    const report = snap.val();

    if (!report || (report.status !== "pending" && report.status !== undefined)) {
      return ctx.answer({ type: "show_snackbar", text: "⚠ Отчет уже обработан или не найден" });
    }

    const [adminUser] = await vk.api.users.get({ user_ids: ctx.userId });
    const adminName = `${adminUser.first_name} ${adminUser.last_name}`;
    const approved = action === "ok";

    // Обновляем статус в БД
    await db.ref(`reports/${reportId}`).update({
      status: approved ? "approved" : "rejected",
      checker: adminName
    });

    // Редактируем сообщение (удаляем кнопки и пишем результат)
    await vk.api.messages.edit({
      peer_id: ctx.peerId,
      conversation_message_id: ctx.conversationMessageId,
      message: 
        `${report.vkText || "Отчет"}\n\n` +
        `${approved ? "✅ ОДОБРЕНО" : "❌ ОТКЛОНЕНО"}\n` +
        `👤 Администратор: ${adminName}`,
      keyboard: Keyboard.builder().inline().toString() // Пустая клавиатура убирает кнопки
    });

    await ctx.answer({ type: "show_snackbar", text: "Успешно сохранено!" });
  } catch (e) {
    console.error("❌ Ошибка при клике по кнопке:", e);
    await ctx.answer({ type: "show_snackbar", text: "Произошла ошибка" });
  }
});

// =======================
// ОТПРАВКА НОВЫХ ОТЧЕТОВ (Firebase -> VK)
// =======================
db.ref("reports").on("child_added", async (snap) => {
  const reportId = snap.key;
  const report = snap.val();

  // Если уже отправлено или нет данных — игнорируем
  if (report.vkMessageId) return;

  const peerId = (await db.ref("settings/chatPeerId").once("value")).val();
  if (!peerId) {
    console.warn("⚠ Чат для отчетов не привязан. Используйте /bind в нужном чате.");
    return;
  }

  const text =
    `📝 НОВЫЙ ОТЧЕТ\n\n` +
    `👤 Ник: ${report.author || "—"}\n` +
    `🔰 Должность: ${report.role || "—"}\n` +
    `📅 Дата: ${report.date || "—"}\n\n` +
    `🛠 Работа: ${report.work || "—"}\n` +
    `⚖️ Наказания: ${report.punishments || "—"}\n` +
    `📊 Баллы: ${report.score || 0}`;

  const attachments = [];
  // Обрабатываем фото (поддержка и массивов, и объектов)
  const photoUrls = report.photos ? Object.values(report.photos) : [];

  for (const url of photoUrls) {
    if (typeof url !== 'string') continue;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Ошибка загрузки: ${response.statusText}`);
      
      const buffer = Buffer.from(await response.arrayBuffer());
      const photo = await vk.upload.messagePhoto({
        source: { value: buffer },
      });
      attachments.push(photo.toString());
    } catch (e) {
      console.error(`❌ Ошибка загрузки фото (${url}):`, e.message);
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
    const sentMsg = await vk.api.messages.send({
      peer_id: Number(peerId),
      random_id: Math.random() * 10000,
      message: text,
      attachment: attachments, // Массив строк напрямую
      keyboard: keyboard.toString()
    });

    await db.ref(`reports/${reportId}`).update({
      vkMessageId: sentMsg,
      vkText: text,
      status: "pending"
    });
  } catch (err) {
    console.error("❌ Ошибка отправки отчета в VK:", err);
  }
});

// =======================
// ЗАПУСК
// =======================
vk.updates.start().catch(console.error);

// HTTP сервер для "здоровья" процесса (Heroku/Render)
http.createServer((_, res) => res.end("Bot is Running")).listen(process.env.PORT || 3000);
