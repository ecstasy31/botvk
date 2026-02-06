import { VK, Keyboard } from "vk-io";
import admin from "firebase-admin";
import fetch from "node-fetch";
import http from "http";
import { Readable } from "stream";

const vk = new VK({
  token: process.env.VK_TOKEN,
  apiVersion: "5.199",
  pollingGroupId: Number(process.env.VK_GROUP_ID)
});

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://modersekb-default-rtdb.firebaseio.com"
});

const db = admin.database();

console.log("🚀 Бот запускается...");

// =======================
// ПРИВЯЗКА БЕСЕДЫ
// =======================
vk.updates.on("message_new", async (ctx) => {
  if (!ctx.text || ctx.isOutbox) return;

  if (ctx.text === "/bind") {
    await db.ref("settings/chatPeerId").set(ctx.peerId);
    return ctx.send(`✅ Беседа привязана\npeer_id: ${ctx.peerId}`);
  }

  if (ctx.text === "/id") {
    return ctx.send(`peer_id: ${ctx.peerId}`);
  }
});

// =======================
// /INFO НИК
// =======================
vk.updates.on("message_new", async (ctx) => {
  if (!ctx.text || ctx.isOutbox) return;
  if (!ctx.text.startsWith("/info")) return;

  const nick = ctx.text.split(" ").slice(1).join(" ").trim();
  if (!nick) return ctx.send("Укажи ник: /info Ник");

  const snap = await db.ref("users").once("value");
  const users = snap.val() || {};

  let found = null;

  for (const id in users) {
    if ((users[id].nickname || "").toLowerCase() === nick.toLowerCase()) {
      found = users[id];
      break;
    }
  }

  if (!found) return ctx.send("❌ Модератор не найден");

  const reportsSnap = await db.ref("reports").once("value");
  const reports = reportsSnap.val() || {};

  const userReports = Object.values(reports)
    .filter(r => r.author === found.nickname);

  const lastReport = userReports.sort((a,b)=> new Date(b.date||0)-new Date(a.date||0))[0];

  const avgScore = userReports.length
    ? Math.round(
        userReports.reduce((s,r)=>s+(parseInt(r.score)||0),0)
        / userReports.length
      )
    : 0;

  const text = `
📋 Информация о модераторе

👤 Ник: ${found.nickname}
🎖 Роль: ${found.role || "не указана"}
🟢 Статус: ${found.active ? "активен" : "неактивен"}

📊 Баллы: ${found.score || 0}
⚠️ Выговоры: ${found.warns || 0}
🚫 Пропуски: ${found.meetMiss || 0}
📝 Отчетов подано: ${userReports.length}

📅 Последний отчет: ${lastReport?.date || "нет"}
📈 Средний уровень отчета: ${avgScore}
`;

  ctx.send(text);
});

// =======================
// КНОПКИ ОДОБРИТЬ / ОТКАЗАТЬ
// =======================
vk.updates.on("message_event", async (ctx) => {
  try {
    if (!ctx.payload) return;

    const { reportId, action } = JSON.parse(ctx.payload);

    const snap = await db.ref(`reports/${reportId}`).once("value");
    const report = snap.val();

    if (!report || report.status !== "pending") {
      return ctx.answer({
        type: "show_snackbar",
        text: "Уже обработано"
      });
    }

    const [user] = await vk.api.users.get({ user_ids: ctx.userId });
    const adminName = `${user.first_name} ${user.last_name}`;

    const approved = action === "ok";

    // ✅ начисляем только при одобрении
    if (approved) {
      const points = parseInt(report.score) || 0;
      await db.ref(`users/${report.author}/score`)
        .transaction(s => (s || 0) + points);
    }

    await db.ref(`reports/${reportId}`).update({
      status: approved ? "approved" : "rejected",
      checker: adminName
    });

    const peerId = (await db.ref("settings/chatPeerId").once("value")).val();

    // Обновляем сообщение: убираем кнопки и добавляем вердикт
    const keyboard = Keyboard.builder()
      .inline()
      .textButton({
        label: approved ? "✅ Одобрено" : "❌ Отклонено",
        color: "secondary"
      });

    await vk.api.messages.edit({
      peer_id: peerId,
      conversation_message_id: ctx.conversationMessageId,
      message: `${report.vkText}\n\n${approved ? "✅ ОДОБРЕНО" : "❌ ОТКЛОНЕНО"}\n👤 Проверил: ${adminName}`,
      keyboard: keyboard.toString()
    });

    ctx.answer({
      type: "show_snackbar",
      text: approved ? "Одобрено" : "Отклонено"
    });

  } catch (e) {
    console.error("❌ Кнопки:", e);
  }
});

// =======================
// НОВЫЙ ОТЧЕТ → В БЕСЕДУ
// =======================
db.ref("reports").on("child_added", async (snap) => {
  const report = snap.val();
  const reportId = snap.key;

  if (!report || report.vkMessageId) return;

  const peerId = (await db.ref("settings/chatPeerId").once("value")).val();
  if (!peerId) {
    console.log("⚠️ Нет /bind");
    return;
  }

  const text =
`📝 НОВЫЙ ОТЧЕТ

👤 Ник: ${report.nickname || report.author}
🔰 Должность: ${report.role}
📅 Дата: ${report.date}

🛠 Работа: ${report.work}
⚖️ Наказания: ${report.punishments}
📊 Баллы: ${report.score}`;

  try {
    // ======================
    // ЗАГРУЗКА ФОТО В VK
    // ======================
    let attachments = [];

    const photoList = []
      .concat(report.photos || [])
      .concat(report.photo || [])
      .filter(Boolean);

    for (const url of photoList) {
      try {
        const res = await fetch(url);
        const buffer = Buffer.from(await res.arrayBuffer());

        const photo = await vk.upload.messagePhoto({
          source: { value: buffer, filename: "photo.jpg" }
        });

        attachments.push(photo.toString());
      } catch (e) {
        console.log("⚠️ Фото не загрузилось:", url);
      }
    }

    // ======================
    // КНОПКИ
    // ======================
    const keyboard = Keyboard.builder()
      .inline()
      .callbackButton({
        label: "✅ Одобрить",
        payload: JSON.stringify({ reportId, action: "ok" }),
        color: "positive"
      })
      .callbackButton({
        label: "❌ Отказать",
        payload: JSON.stringify({ reportId, action: "no" }),
        color: "negative"
      });

    // ======================
    // ОТПРАВКА
    // ======================
    const messageId = await vk.api.messages.send({
      peer_id: peerId,
      random_id: Date.now(),
      message: text,
      attachment: attachments.join(","),
      keyboard: keyboard.toString()
    });

    await db.ref(`reports/${reportId}`).update({
      vkMessageId: messageId,
      vkText: text,
      status: "pending"
    });

    console.log("✅ Отчет отправлен с фото и кнопками");

  } catch (e) {
    console.error("❌ SEND:", e);
  }
});

// =======================
// ЗАПУСК
// =======================
vk.updates.start()
  .then(() => console.log("✅ Polling started"))
  .catch(console.error);

http.createServer((req, res) => {
  res.end("Bot OK");
}).listen(process.env.PORT || 3000);
