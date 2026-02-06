import { VK, Keyboard } from "vk-io";
import admin from "firebase-admin";
import http from "http";

console.log("=== VK REPORT BOT START ===");

// ================= VK КОНФИГУРАЦИЯ =================
const vk = new VK({
  token: process.env.VK_TOKEN, // Токен всё еще берем из .env (это секрет)
  apiVersion: "5.199",
  uploadTimeout: 10000
});

// === ВАШ CHAT_ID (ВСТАВЛЕН СЮДА) ===
const CHAT_ID = 2000000086; 

console.log("TARGET CHAT_ID:", CHAT_ID);

// ================= FIREBASE =================
let serviceAccount;
try {
  // Ключ Firebase берем из .env
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
} catch (e) {
  console.error("ОШИБКА: Неверный формат FIREBASE_KEY в .env");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://modersekb-default-rtdb.firebaseio.com"
});

const db = admin.database();
console.log("Firebase connected");

// ================= ОБРАБОТКА КНОПОК (CALLBACK) =================
vk.updates.on("message_event", async (ctx) => {
  try {
    const { reportId, action } = ctx.payload;

    // Получаем отчет из базы
    const snap = await db.ref(`reports/${reportId}`).once("value");
    const report = snap.val();

    // Если отчета нет или он уже обработан
    if (!report || report.status !== "pending") {
      return ctx.answer({
        type: "show_snackbar",
        text: "Уже обработан или не найден"
      });
    }

    // Получаем имя админа
    const [adminUser] = await vk.api.users.get({ user_ids: ctx.userId });
    const adminName = `${adminUser.first_name} ${adminUser.last_name}`;
    
    const newStatus = action === "ok" ? "approved" : "rejected";
    const statusText = action === "ok" ? "✅ ОДОБРЕНО" : "❌ ОТКЛОНЕНО";

    // 1. Обновляем статус в БД
    await db.ref(`reports/${reportId}`).update({
      status: newStatus,
      reviewedBy: adminName,
      reviewedAt: Date.now()
    });

    // 2. Если одобрено — начисляем баллы
    if (action === "ok") {
      await db.ref(`users/${report.author}`).transaction(u => {
        if (!u) return u;
        u.score = (u.score || 0) + (Number(report.score) || 0);
        return u;
      });
    }

    // 3. Редактируем сообщение (убираем кнопки, пишем итог)
    try {
      await vk.api.messages.edit({
        peer_id: CHAT_ID,
        message_id: report.vkMessageId,
        message: `${report.vkText}\n\n${statusText}\n👤 Проверил: ${adminName}`,
        attachment: report.vkAttachments, 
        keyboard: Keyboard.builder().clear()
      });
    } catch (err) {
      console.error("Ошибка редактирования сообщения:", err.message);
    }

    // 4. Уведомление админу
    await ctx.answer({
      type: "show_snackbar",
      text: action === "ok" ? "Одобрено" : "Отклонено"
    });

  } catch (e) {
    console.error("CALLBACK ERROR:", e);
  }
});

// Запуск бота
vk.updates.start().then(() => {
  console.log("VK Updates Started");
}).catch(console.error);

// ================= СЛУШАТЕЛЬ НОВЫХ ОТЧЕТОВ =================
db.ref("reports").on("child_added", async (snap) => {
  try {
    const reportId = snap.key;
    const report = snap.val();

    // Пропускаем уже обработанные отчеты
    if (!report || report.status) return;

    console.log(`Новый отчет: ${reportId} от ${report.author}`);

    const text = 
`📝 ОТЧЕТ

👤 ${report.author}
🎖 ${report.rank}
📊 Баллы: ${report.score}
📅 ${report.date}

${report.work}
`;

    let attachments = [];

    // --- ЗАГРУЗКА ФОТО ---
    if (Array.isArray(report.imgs) && report.imgs.length > 0) {
      const uploadPromises = report.imgs.map(async (base64Str) => {
        try {
          // Чистим base64
          const base64Data = base64Str.replace(/^data:image\/\w+;base64,/, "");
          const buffer = Buffer.from(base64Data, 'base64');
          
          // Загружаем через vk-io
          const photo = await vk.upload.messagePhoto({
            source: buffer,
            peer_id: CHAT_ID
          });
          
          return photo.toString(); 
        } catch (err) {
          console.error("Ошибка загрузки фото:", err.message);
          return null;
        }
      });

      const results = await Promise.all(uploadPromises);
      attachments = results.filter(Boolean);
    }

    // Клавиатура
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

    // Отправка сообщения в беседу
    const sentMsg = await vk.api.messages.send({
      peer_id: CHAT_ID,
      random_id: Math.floor(Math.random() * 1000000000),
      message: text,
      attachment: attachments.join(","),
      keyboard
    });

    console.log("Сообщение отправлено, ID:", sentMsg);

    // Сохраняем данные сообщения в БД
    await db.ref(`reports/${reportId}`).update({
      status: "pending",
      vkMessageId: sentMsg,
      vkText: text,
      vkAttachments: attachments.join(",") 
    });

  } catch (e) {
    console.error("VK SEND ERROR:", e);
  }
});

// ================= HTTP СЕРВЕР =================
http.createServer((_, res) => {
  res.writeHead(200);
  res.end(`Bot running. Target Chat ID: ${CHAT_ID}`);
}).listen(process.env.PORT || 3000);
