import { VK } from "vk-io";
import admin from "firebase-admin";
import fetch from "node-fetch";
console.log("Bot starting...");


// ===== VK =====
const vk = new VK({
  token: process.env.VK_TOKEN
});

const CHAT_ID = process.env.CHAT_ID;

// ===== Firebase =====
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
  databaseURL: "https://modersekb-default-rtdb.firebaseio.com"
});

const db = admin.database();

db.ref("reports").on("child_added", snap => {
  console.log("NEW REPORT:", snap.key);
});


// ===== Слушаем новые отчёты =====
db.ref("reports").on("child_added", async snap => {
  const report = snap.val();
  if (report.status !== "pending") return;

  const text = `
📝 ОТЧЕТ МОДЕРАТОРА

👤 Ник: ${report.author}
🎖 Должность: ${report.rank}
📅 Дата: ${report.date}

📌 Работа:
${report.work}

🚫 Наказаний: ${report.punishments}
  `;

  // Загружаем фото в VK
  let attachments = [];

  for (const url of report.photos || []) {
    const photo = await uploadPhoto(url);
    attachments.push(photo);
  }

  const msg = await vk.api.messages.send({
    peer_id: CHAT_ID,
    random_id: Date.now(),
    message: text,
    attachment: attachments.join(","),
    keyboard: JSON.stringify({
      inline: true,
      buttons: [
        [{
          action: { type: "callback", label: "✅ Одобрить", payload: { id: snap.key, a: "ok" } },
          color: "positive"
        }],
        [{
          action: { type: "callback", label: "❌ Отклонить", payload: { id: snap.key, a: "no" } },
          color: "negative"
        }]
      ]
    })
  });

  db.ref(`reports/${snap.key}/vkMessageId`).set(msg);
});

// ===== Загрузка фото =====
async function uploadPhoto(url) {
  const server = await vk.api.photos.getMessagesUploadServer({ peer_id: CHAT_ID });
  const buffer = await fetch(url).then(r => r.buffer());

  const form = new FormData();
  form.append("photo", buffer, "img.jpg");

  const upload = await fetch(server.upload_url, { method: "POST", body: form }).then(r => r.json());
  const saved = await vk.api.photos.saveMessagesPhoto(upload);

  return `photo${saved[0].owner_id}_${saved[0].id}`;
}

vk.updates.on("message_event", async ctx => {
  const { id, a } = ctx.payload;

  await db.ref(`reports/${id}/status`)
    .set(a === "ok" ? "approved" : "rejected");

  await ctx.answer({
    type: "show_snackbar",
    text: a === "ok" ? "Отчет одобрен" : "Отчет отклонён"
  });
});

import http from "http";

const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("VK bot is alive");
}).listen(PORT, () => {
  console.log("HTTP server started on port", PORT);
});


