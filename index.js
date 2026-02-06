import { VK, Keyboard } from "vk-io";
import admin from "firebase-admin";
import fetch from "node-fetch";
import FormData from "form-data";
import http from "http";

console.log("=== VK REPORT BOT START ===");

// ================= VK =================
const vk = new VK({
  token: process.env.VK_TOKEN
});

const CHAT_ID = Number(process.env.CHAT_ID);
console.log("CHAT_ID:", CHAT_ID);

// ================= FIREBASE =================
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_KEY)
  ),
  databaseURL: "https://modersekb-default-rtdb.firebaseio.com"
});

const db = admin.database();
console.log("Firebase connected");

// ================= PHOTO UPLOAD =================
async function uploadPhoto(base64) {
  const server = await vk.api.photos.getMessagesUploadServer();

  const buffer = Buffer.from(
    base64.replace(/^data:image\/\w+;base64,/, ""),
    "base64"
  );

  const form = new FormData();
  form.append("photo", buffer, "report.png");

  const upload = await fetch(server.upload_url, {
    method: "POST",
    body: form
  }).then(r => r.json());

  const saved = await vk.api.photos.saveMessagesPhoto(upload);
  return `photo${saved[0].owner_id}_${saved[0].id}`;
}

// ================= BUTTON HANDLER =================
vk.updates.on("message_event", async (ctx) => {
  const { reportId, action } = ctx.payload;

  const snap = await db.ref(`reports/${reportId}`).once("value");
  const report = snap.val();

  if (!report || report.status !== "pending") {
    return ctx.answer({
      type: "show_snackbar",
      text: "⚠️ Отчет уже обработан"
    });
  }

  const adminId = ctx.userId;
  const [admin] = await vk.api.users.get({ user_ids: adminId });
  const adminName = `${admin.first_name} ${admin.last_name}`;

  const newStatus = action === "ok" ? "approved" : "rejected";

  await db.ref(`reports/${reportId}`).update({
    status: newStatus,
    reviewedBy: adminName,
    reviewedAt: Date.now()
  });

  // ===== начисление баллов =====
  if (action === "ok") {
    await db.ref(`users/${report.author}`).transaction(u => {
      if (!u) return u;
      u.score = (u.score || 0) + (report.score || 0);
      return u;
    });
  }

  const statusText =
    action === "ok"
      ? `✅ СТАТУС: ОДОБРЕН\n👮 Проверил: ${adminName}`
      : `❌ СТАТУС: ОТКЛОНЁН\n👮 Проверил: ${adminName}`;

  await vk.api.messages.edit({
    peer_id: CHAT_ID,
    message_id: report.vkMessageId,
    message: report.vkText + `\n\n${statusText}`,
    keyboard: Keyboard.builder().clear()
  });

  await db.ref("logs").push({
    type: "report_review",
    reportId,
    status: newStatus,
    admin: adminName,
    time: Date.now()
  });

  await ctx.answer({
    type: "show_snackbar",
    text: action === "ok" ? "✅ Отчет одобрен" : "❌ Отчет отклонён"
  });
});

vk.updates.start();

// ================= REPORT LISTENER =================
db.ref("reports").on("child_added", async (snap) => {
  const reportId = snap.key;
  const report = snap.val();

  if (!report) return;
  if (report.status && report.status !== "pending") return;

  const text =
`📝 ОТЧЕТ МОДЕРАТОРА

👤 Ник: ${report.author}
🎖 Должность: ${report.rank}
📅 Дата: ${report.date}

📌 Работа:
${report.work}

🚫 Наказаний: ${report.score || 0}
`;

  let attachments = [];

  if (Array.isArray(report.imgs)) {
    for (const img of report.imgs) {
      try {
        attachments.push(await uploadPhoto(img));
      } catch {}
    }
  }

  const keyboard = Keyboard.builder()
    .inline()
    .callbackButton({
      label: "✅ Одобрить",
      payload: { reportId, action: "ok" },
      color: Keyboard.POSITIVE_COLOR
    })
    .callbackButton({
      label: "❌ Отклонить",
      payload: { reportId, action: "no" },
      color: Keyboard.NEGATIVE_COLOR
    });

  const msgId = await vk.api.messages.send({
    peer_id: CHAT_ID,
    random_id: Date.now(),
    message: text,
    attachment: attachments.join(","),
    keyboard
  });

  await db.ref(`reports/${reportId}`).update({
    status: "pending",
    vkMessageId: msgId,
    vkText: text
  });

  console.log("REPORT SENT:", reportId);
});

// ================= HTTP =================
http.createServer((_, res) => {
  res.end("VK report bot alive");
}).listen(process.env.PORT || 3000);
