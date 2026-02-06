import { VK, Keyboard } from "vk-io";
import admin from "firebase-admin";
import fetch from "node-fetch";
import FormData from "form-data";
import http from "http";

console.log("=== VK REPORT BOT START ===");

// ================= VK =================
const vk = new VK({
  token: process.env.VK_TOKEN,
  apiVersion: "5.199"
});

// если в ENV уже полный peer_id — используй его
// если там только номер беседы (например 86) — прибавляем
let CHAT_ID = Number(process.env.CHAT_ID);

if (CHAT_ID < 2000000000) {
  CHAT_ID = 2000000000 + CHAT_ID;
}

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

// ================= CALLBACK =================
vk.updates.on("message_event", async (ctx) => {
  try {
    const { reportId, action } = ctx.payload;

    const snap = await db.ref(`reports/${reportId}`).once("value");
    const report = snap.val();

    if (!report || report.status !== "pending") {
      return ctx.answer({
        event_id: ctx.eventId,
        type: "show_snackbar",
        text: "Уже обработан"
      });
    }

    const [adminUser] = await vk.api.users.get({
      user_ids: ctx.userId
    });

    const adminName = `${adminUser.first_name} ${adminUser.last_name}`;
    const newStatus = action === "ok" ? "approved" : "rejected";

    await db.ref(`reports/${reportId}`).update({
      status: newStatus,
      reviewedBy: adminName,
      reviewedAt: Date.now()
    });

    if (action === "ok") {
      await db.ref(`users/${report.author}`).transaction(u => {
        if (!u) return u;
        u.score = (u.score || 0) + (report.score || 0);
        return u;
      });
    }

    await vk.api.messages.edit({
      peer_id: CHAT_ID,
      message_id: report.vkMessageId,
      message:
        report.vkText +
        `\n\nСтатус: ${newStatus.toUpperCase()}\nПроверил: ${adminName}`,
      keyboard: Keyboard.builder().clear()
    });

    await ctx.answer({
      event_id: ctx.eventId,
      type: "show_snackbar",
      text: newStatus === "approved" ? "Одобрено" : "Отклонено"
    });

  } catch (e) {
    console.error("CALLBACK ERROR:", e);
  }
});

vk.updates.start().then(() => {
  console.log("VK updates started");
});

// ================= REPORT LISTENER =================
db.ref("reports").on("child_added", async (snap) => {
  try {
    const reportId = snap.key;
    const report = snap.val();

    if (!report || report.status) return;

    const text =
`📝 ОТЧЕТ

👤 ${report.author}
🎖 ${report.rank}
📅 ${report.date}

${report.work}
`;

    let attachments = [];

    if (Array.isArray(report.imgs)) {
      for (const img of report.imgs) {
        try {
          const ph = await uploadPhoto(img);
          attachments.push(ph);
        } catch (e) {
          console.warn("PHOTO UPLOAD FAIL");
        }
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

    console.log("REPORT SENT:", msgId);

    await db.ref(`reports/${reportId}`).update({
      status: "pending",
      vkMessageId: msgId,
      vkText: text
    });

  } catch (e) {
    console.error("VK SEND ERROR:", e);
  }
});

// ================= HTTP =================
http.createServer((_, res) => {
  res.end("VK bot alive");
}).listen(process.env.PORT || 3000);
