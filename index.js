import { VK, Keyboard } from "vk-io";
import admin from "firebase-admin";
import fetch from "node-fetch";
import http from "http";

// =======================
// VK
// =======================
const vk = new VK({
  token: process.env.VK_TOKEN,
  apiVersion: "5.199",
  pollingGroupId: Number(process.env.VK_GROUP_ID)
});

vk.updates.useCallback(); // 🔥 ОБЯЗАТЕЛЬНО ДЛЯ КНОПОК

// =======================
// FIREBASE
// =======================
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
  databaseURL: "https://modersekb-default-rtdb.firebaseio.com"
});

const db = admin.database();
console.log("🚀 Бот запущен");

// =======================
// MESSAGE_NEW
// =======================
vk.updates.on("message_new", async (ctx) => {
  if (ctx.isOutbox || !ctx.text) return;
  const text = ctx.text.trim();

  if (text === "/bind") {
    await db.ref("settings/chatPeerId").set(ctx.peerId);
    return ctx.send(`✅ Беседа привязана\npeer_id: ${ctx.peerId}`);
  }

  if (text === "/id") {
    return ctx.send(`peer_id: ${ctx.peerId}`);
  }

  // =======================
  // /INFO
  // =======================
  if (text.startsWith("/info")) {
    const nick = text.replace("/info", "").trim();
    if (!nick) return ctx.send("❗ Используй: /info Ник");

    const usersSnap = await db.ref("users").once("value");
    const users = usersSnap.val() || {};

    let userData = Object.values(users).find(
      u => (u.nickname || "").toLowerCase() === nick.toLowerCase()
    );

    const reportsSnap = await db.ref("reports").once("value");
    const reports = reportsSnap.val() || {};

    const userReports = Object.values(reports).filter(
      r => (r.author || "").toLowerCase() === nick.toLowerCase()
    );

    if (!userData && userReports.length === 0) {
      return ctx.send("❌ Модератор не найден");
    }

    const lastReport = userReports.sort(
      (a, b) => new Date(b.date || 0) - new Date(a.date || 0)
    )[0];

    const avgScore = userReports.length
      ? Math.round(userReports.reduce((s, r) => s + Number(r.score || 0), 0) / userReports.length)
      : 0;

    return ctx.send(
`📋 ИНФОРМАЦИЯ О МОДЕРАТОРЕ

👤 Ник: ${nick}
🎖 Роль: ${userData?.role || lastReport?.role || "не указана"}
🟢 Статус: ${userData?.active ? "активен" : "неактивен"}

📊 Баллы: ${userData?.score || 0}
📝 Отчетов: ${userReports.length}
📅 Последний отчет: ${lastReport?.date || "нет"}
📈 Средний балл: ${avgScore}`
    );
  }
});

// =======================
// КНОПКИ
// =======================
vk.updates.on("message_event", async (ctx) => {
  try {
    const payload = typeof ctx.payload === "string"
      ? JSON.parse(ctx.payload)
      : ctx.payload;

    const { reportId, action } = payload || {};
    if (!reportId) return ctx.answer();

    const snap = await db.ref(`reports/${reportId}`).once("value");
    const report = snap.val();
    if (!report || report.status !== "pending") {
      return ctx.answer({ type: "show_snackbar", text: "Уже обработано" });
    }

    const [adminUser] = await vk.api.users.get({ user_ids: ctx.userId });
    const adminName = `${adminUser.first_name} ${adminUser.last_name}`;
    const approved = action === "ok";

    if (approved) {
      const usersSnap = await db.ref("users").once("value");
      const users = usersSnap.val() || {};
      const uid = Object.keys(users).find(
        k => users[k].nickname === report.author
      );

      if (uid) {
        await db.ref(`users/${uid}/score`)
          .transaction(v => (v || 0) + Number(report.score || 0));
      }
    }

    await db.ref(`reports/${reportId}`).update({
      status: approved ? "approved" : "rejected",
      checker: adminName
    });

    const peerId = (await db.ref("settings/chatPeerId").once("value")).val();

    const keyboard = Keyboard.builder()
      .inline()
      .textButton({
        label: approved ? "✅ Одобрено" : "❌ Отклонено",
        color: approved ? "positive" : "negative",
        payload: { done: true }
      });

    await vk.api.messages.edit({
      peer_id: peerId,
      conversation_message_id: ctx.conversationMessageId,
      message:
        `${report.vkText}\n\n` +
        `${approved ? "✅ ОДОБРЕНО" : "❌ ОТКЛОНЕНО"}\n` +
        `👤 Администратор: ${adminName}`,
      keyboard: keyboard.toString()
    });

    await ctx.answer({ type: "show_snackbar", text: "Готово!" });
  } catch (e) {
    console.error("❌ Кнопки:", e);
    try { await ctx.answer(); } catch {}
  }
});

// =======================
// ОТЧЕТЫ + ФОТО
// =======================
async function startReportListener() {
  db.ref("reports").on("child_added", async (snap) => {
    const reportId = snap.key;
    const report = snap.val();
    if (report.vkMessageId) return;

    const peerId = (await db.ref("settings/chatPeerId").once("value")).val();
    if (!peerId) return;

    const text =
`📝 НОВЫЙ ОТЧЕТ

👤 Ник: ${report.author}
🔰 Должность: ${report.role}
📅 Дата: ${report.date}

🛠 Работа: ${report.work}
⚖️ Наказания: ${report.punishments}
📊 Баллы: ${report.score}`;

    const attachments = [];

    const photos = Object.values(report.photos || {});
    for (const url of photos) {
      try {
        const r = await fetch(url);
        const buffer = Buffer.from(await r.arrayBuffer());
        const photo = await vk.upload.messagePhoto({
          source: { value: buffer, filename: "photo.jpg" }
        });
        attachments.push(photo.toString());
      } catch (e) {
        console.error("❌ Фото:", e.message);
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

    const msgId = await vk.api.messages.send({
      peer_id: peerId,
      random_id: Date.now(),
      message: text,
      attachment: attachments.join(","),
      keyboard: keyboard.toString()
    });

    await db.ref(`reports/${reportId}`).update({
      vkMessageId: msgId,
      vkText: text,
      status: "pending"
    });
  });
}

// =======================
startReportListener();
vk.updates.start();
http.createServer((_, res) => res.end("Bot Work")).listen(process.env.PORT || 3000);
