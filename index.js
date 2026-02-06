import { VK } from "vk-io";
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

// ================= UPLOAD PHOTO =================
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
  const payload = JSON.parse(ctx.payload);
  const { reportId, action } = payload;

  const reportSnap = await db.ref(`reports/${reportId}`).once("value");
  const report = reportSnap.val();

  if (!report || report.status !== "pending") {
    return ctx.answer({
      type: "show_snackbar",
      text: "⚠️ Отчет уже обработан"
    });
  }

  const adminId = ctx.userId;
  const adminInfo = await vk.api.users.get({ user_ids: adminId });
  const adminName = `${adminInfo[0].first_name} ${adminInfo[0].last_name}`;

  // ===== обновляем статус =====
  const newStatus = action === "ok" ? "approved" : "rejected";

  await db.ref(`reports/${reportId}`).update({
    status: newStatus,
    reviewedBy: adminName,
    reviewedAt: Date.now()
  });

  // ===== начисление баллов ТОЛЬКО при одобрении =====
  if (action === "ok") {
    await db.ref(`users/${report.author}`).transaction(u => {
      if (!u) return u;
      u.score = (u.score || 0) + (report.score || 0);
      u.reportsCount = (u.reportsCount || 0) + 1;
      return u;
    });
  }

  // ===== редактирование сообщения =====
  const statusText =
    action === "ok"
      ? `✅ СТАТУС: ОДОБРЕН\n👮 Проверил: ${adminName}`
      : `❌ СТАТУС: ОТКЛОНЁН\n👮 Проверил: ${adminName}`;

  await vk.api.messages.edit({
    peer_id: CHAT_ID,
    message_id: report.vkMessageId,
    message: report.vkText + `\n\n${statusText}`,
    keyboard: JSON.stringify({ buttons: [] })
  });

  // ===== лог =====
  await db.ref("logs").push({
    type: "report_review",
    reportId,
    action: newStatus,
    admin: adminName,
    author: report.author,
    time: Date.now()
  });

  await ctx.answer({
    type: "show_snackbar",
    text: action === "ok" ? "✅ Отчет одобрен" : "❌ Отчет отклонён"
  });
});

vk.updates.start().then(() => {
  console.log("VK updates started");
});

// ================= REPORT LISTENER =================
db.ref("reports").on("child_added", async (snap) => {
  const reportId = snap.key;
  const report = snap.val();

  if (!report) return;
  if (report.status && report.status !== "pending") return;

  console.log("NEW REPORT:", reportId);

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
        const photo = await uploadPhoto(img);
        attachments.push(photo);
      } catch (e) {
        console.error("PHOTO ERROR:", e);
      }
    }
  }

  const keyboard = {
    inline: true,
    buttons: [[
      {
        action: {
          type: "callback",
          label: "✅ Одобрить",
          payload: JSON.stringify({ reportId, action: "ok" })
        },
        color: "positive"
      },
      {
        action: {
          type: "callback",
          label: "❌ Отклонить",
          payload: JSON.stringify({ reportId, action: "no" })
        },
        color: "negative"
      }
    ]]
  };

  try {
    const msgId = await vk.api.messages.send({
      peer_id: CHAT_ID,
      random_id: Date.now(),
      message: text,
      attachment: attachments.join(","),
      keyboard: JSON.stringify(keyboard)
    });

    await db.ref(`reports/${reportId}`).update({
      status: "pending",
      vkMessageId: msgId,
      vkText: text
    });

    console.log("REPORT SENT:", msgId);
  } catch (e) {
    console.error("VK SEND ERROR:", e);
  }
});

// ================= HTTP KEEP ALIVE =================
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("VK report bot alive");
}).listen(PORT, () => {
  console.log("HTTP server started:", PORT);
});
