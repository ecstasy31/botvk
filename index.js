import { VK, Keyboard } from "vk-io";
import admin from "firebase-admin";
import http from "http";

// ⚠️ ВСТАВЬ СЮДА peer_id беседы (бот покажет через /id)
const TARGET_PEER_ID = 2000000086;

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
// ТЕСТ КОМАНДЫ
// =======================

vk.updates.on("message_new", async (ctx) => {
  if (!ctx.text || ctx.isOutbox) return;

  if (ctx.text === "/start" || ctx.text === "/id") {
    return ctx.send(
      `✅ Бот работает\npeer_id этого чата: ${ctx.peerId}\nTARGET_PEER_ID: ${TARGET_PEER_ID}`
    );
  }
});


// =======================
// КНОПКИ ОДОБРИТЬ / ОТКАЗАТЬ
// =======================

vk.updates.on("message_event", async (ctx) => {
  try {
    if (!ctx.payload) {
      return ctx.answer({
        type: "show_snackbar",
        text: "Нет payload"
      });
    }

    const { reportId, action } = ctx.payload;

    const snap = await db.ref(`reports/${reportId}`).once("value");
    const report = snap.val();

    if (!report || report.status !== "pending") {
      return ctx.answer({
        type: "show_snackbar",
        text: "❌ Уже обработано"
      });
    }

    const [user] = await vk.api.users.get({ user_ids: ctx.userId });
    const adminName = `${user.first_name} ${user.last_name}`;
    const isOk = action === "ok";

    // начисление баллов
    if (isOk) {
      const pointsToAdd = parseInt(report.score) || 0;

      await db.ref(`users/${report.author}/score`)
        .transaction(s => (s || 0) + pointsToAdd);
    }

    await db.ref(`reports/${reportId}`).update({
      status: isOk ? "approved" : "rejected",
      checker: adminName
    });

    await vk.api.messages.edit({
      peer_id: TARGET_PEER_ID,
      conversation_message_id: ctx.conversationMessageId,
      message:
`${report.vkText}

${isOk ? "✅ ОДОБРЕНО" : "❌ ОТКЛОНЕНО"}
👤 Проверил: ${adminName}`,
      keyboard: Keyboard.builder().toString()
    });

    await ctx.answer({
      type: "show_snackbar",
      text: isOk ? "Принято" : "Отказано"
    });

  } catch (e) {
    console.error("❌ Ошибка кнопок:", e);
  }
});


// =======================
// ОТПРАВКА НОВЫХ ОТЧЕТОВ В ВК
// =======================

db.ref("reports").on("child_added", async (snap) => {
  const report = snap.val();
  const reportId = snap.key;

  if (!report) return;
  if (report.vkMessageId) return;

  console.log("📩 Новый отчет:", reportId);

  const text =
`📝 НОВЫЙ ОТЧЕТ

👤 Ник: ${report.nickname || report.author}
🔰 Должность: ${report.role}
📅 Дата: ${report.date}

🛠 Работа: ${report.work}
⚖️ Наказания: ${report.punishments}
📊 К начислению: ${report.score} баллов`;

  try {
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

    const messageId = await vk.api.messages.send({
      peer_id: TARGET_PEER_ID,
      random_id: Math.floor(Math.random() * 1e9),
      message: text,
      keyboard: keyboard.toString()
    });

    await db.ref(`reports/${reportId}`).update({
      vkMessageId: messageId,
      vkText: text,
      status: "pending"
    });

    console.log("✅ Отправлено в беседу:", messageId);

  } catch (e) {
    console.error("❌ Ошибка отправки VK:");
    console.error(e);
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
