import { VK, Keyboard } from "vk-io";
import admin from "firebase-admin";
import http from "http";

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
// КНОПКИ
// =======================

vk.updates.on("message_event", async (ctx) => {
  try {
    if (!ctx.payload) return;

    const { reportId } = ctx.payload;

    const snap = await db.ref(`reports/${reportId}`).once("value");
    const report = snap.val();
    if (!report) return;

    const [user] = await vk.api.users.get({ user_ids: ctx.userId });
    const adminName = `${user.first_name} ${user.last_name}`;

    const peerSnap = await db.ref("settings/chatPeerId").once("value");
    const peerId = peerSnap.val();

    await vk.api.messages.edit({
      peer_id: peerId,
      conversation_message_id: ctx.conversationMessageId,
      message:
`${report.vkText}

👤 Проверил: ${adminName}`,
      keyboard: Keyboard.builder().toString()
    });

    ctx.answer({
      type: "show_snackbar",
      text: "Отмечено"
    });

  } catch (e) {
    console.error("❌ Кнопки:", e);
  }
});


// =======================
// НОВЫЕ ОТЧЕТЫ → ВК + АВТО НАЧИСЛЕНИЕ
// =======================

db.ref("reports").on("child_added", async (snap) => {
  const report = snap.val();
  const reportId = snap.key;

  if (!report || report.vkMessageId) return;

  const peerSnap = await db.ref("settings/chatPeerId").once("value");
  const peerId = peerSnap.val();

  if (!peerId) {
    console.log("❌ Беседа не привязана. Напишите /bind");
    return;
  }

  console.log("📩 Новый отчет:", reportId);

  const text =
`📝 НОВЫЙ ОТЧЕТ

👤 Ник: ${report.nickname || report.author}
🔰 Должность: ${report.role}
📅 Дата: ${report.date}

🛠 Работа: ${report.work}
⚖️ Наказания: ${report.punishments}
📊 Баллы: ${report.score}`;

  try {
    // ✅ авто начисление баллов
    const points = parseInt(report.score) || 0;

    await db.ref(`users/${report.author}/score`)
      .transaction(s => (s || 0) + points);

    const keyboard = Keyboard.builder()
      .inline()
      .callbackButton({
        label: "👀 Проверено",
        payload: { reportId },
        color: "primary"
      });

    const messageId = await vk.api.messages.send({
      peer_id: peerId,
      random_id: Date.now(),
      message: text,
      keyboard: keyboard.toString()
    });

    await db.ref(`reports/${reportId}`).update({
      vkMessageId: messageId,
      vkText: text,
      status: "auto_approved"
    });

    console.log("✅ Отправлено + баллы начислены");

  } catch (e) {
    console.error("❌ VK SEND:", e);
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
