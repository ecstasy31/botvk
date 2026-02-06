import { VK } from "vk-io";
import admin from "firebase-admin";
import http from "http";
import fetch from "node-fetch";
import FormData from "form-data";

console.log("=== VK REPORT BOT START ===");

// ================= VK =================
const vk = new VK({
  token: process.env.VK_TOKEN
});

const CHAT_ID = Number(process.env.CHAT_ID);
console.log("CHAT_ID:", 2000000086);

// ================= FIREBASE =================
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_KEY)
  ),
  databaseURL: "https://modersekb-default-rtdb.firebaseio.com"
});

const db = admin.database();
console.log("Firebase connected");

// ================= HELPER: UPLOAD PHOTO =================
async function uploadPhoto(base64) {
  const uploadServer = await vk.api.photos.getMessagesUploadServer();

  const buffer = Buffer.from(
    base64.replace(/^data:image\/\w+;base64,/, ""),
    "base64"
  );

  const form = new FormData();
  form.append("photo", buffer, "report.png");

  const uploadRes = await fetch(uploadServer.upload_url, {
    method: "POST",
    body: form
  }).then(r => r.json());

  const saved = await vk.api.photos.saveMessagesPhoto(uploadRes);

  return `photo${saved[0].owner_id}_${saved[0].id}`;
}

// ================= BUTTON HANDLER =================
vk.updates.on("message_event", async (ctx) => {
  const { reportId, action } = ctx.payload;

  await db.ref(`reports/${reportId}/status`)
    .set(action === "ok" ? "approved" : "rejected");

  await ctx.answer({
    type: "show_snackbar",
    text: action === "ok" ? "✅ Отчет одобрен" : "❌ Отчет отклонён"
  });
});

vk.updates.start().then(() => {
  console.log("VK updates started");
});

// ================= FIREBASE LISTENER =================
db.ref("reports").on("child_added", async (snap) => {
  const reportId = snap.key;
  const report = snap.val();

  if (!report) return;

  // ✅ если статус уже есть — НЕ шлём
  if (report.status && report.status !== "pending") return;

  console.log("NEW REPORT:", reportId);

  const text =
`📝 ОТЧЕТ МОДЕРАТОРА

👤 Ник: ${report.author}
🎖 Должность: ${report.rank}
📅 Дата: ${report.date}

📌 Работа:
${report.work}

🚫 Наказаний: ${report.punishments ?? report.score ?? 0}
`;

  try {
    // ===== загрузка фоток =====
    let attachments = [];

    if (Array.isArray(report.imgs)) {
      for (const img of report.imgs) {
        try {
          const photo = await uploadPhoto(img);
          attachments.push(photo);
        } catch (e) {
          console.error("PHOTO UPLOAD ERROR", e);
        }
      }
    }

    // ===== кнопки =====
    const keyboard = {
      inline: true,
      buttons: [[
        {
          action: {
            type: "callback",
            label: "✅ Одобрить",
            payload: { reportId, action: "ok" }
          },
          color: "positive"
        },
        {
          action: {
            type: "callback",
            label: "❌ Отклонить",
            payload: { reportId, action: "no" }
          },
          color: "negative"
        }
      ]]
    };

    const msgId = await vk.api.messages.send({
      peer_id: CHAT_ID,
      random_id: Date.now(),
      message: text,
      attachment: attachments.join(","),
      keyboard
    });

    console.log("VK MESSAGE SENT:", msgId);

    await db.ref(`reports/${reportId}`).update({
      status: "pending",
      vkMessageId: msgId
    });

  } catch (err) {
    console.error("VK SEND ERROR:", err);
  }
});

// ================= HTTP SERVER =================
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("VK bot alive");
}).listen(PORT, () => {
  console.log("HTTP server started on port", PORT);
});
