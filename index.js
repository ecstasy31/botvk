import { VK } from "vk-io";
import admin from "firebase-admin";
import fetch from "node-fetch";
import http from "http";
import FormData from "form-data";

console.log("=== BOT STARTING ===");

// ================= VK =================
console.log("VK TOKEN EXISTS:", !!process.env.VK_TOKEN);
console.log("CHAT_ID:", process.env.CHAT_ID);

const vk = new VK({
  token: process.env.VK_TOKEN
});

const CHAT_ID = Number(process.env.CHAT_ID);

// ================= FIREBASE =================
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_KEY)
  ),
  databaseURL: "https://modersekb-default-rtdb.firebaseio.com"
});

const db = admin.database();
console.log("Firebase connected");

// ================= VK UPDATES =================
vk.updates.on("message_event", async (ctx) => {
  const { id, a } = ctx.payload;

  await db.ref(`reports/${id}/status`)
    .set(a === "ok" ? "approved" : "rejected");

  await ctx.answer({
    type: "show_snackbar",
    text: a === "ok" ? "Отчет одобрен" : "Отчет отклонён"
  });
});

vk.updates.start().then(() => {
  console.log("VK updates started");
});

// ================= FIREBASE LISTENER =================
db.ref("reports").on("child_added", async (snap) => {
  console.log("NEW REPORT:", snap.key);

  const report = snap.val();
  if (!report || report.status !== "pending") return;

  const text = `
📝 ОТЧЕТ МОДЕРАТОРА

👤 Ник: ${report.author}
🎖 Должность: ${report.rank}
📅 Дата: ${report.date}

📌 Работа:
${report.work}

🚫 Наказаний: ${report.punishments}
  `;

  try {
    const msgId = await vk.api.messages.send({
      peer_id: CHAT_ID,
      random_id: Date.now(),
      message: text
    });

    console.log("VK MESSAGE SENT:", msgId);

    await db.ref(`reports/${snap.key}/vkMessageId`).set(msgId);

  } catch (err) {
    console.error("VK SEND ERROR:", err);
  }
});

// ================= HTTP SERVER (Render Free Fix) =================
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("VK bot is alive");
}).listen(PORT, () => {
  console.log("HTTP server started on port", PORT);
});



