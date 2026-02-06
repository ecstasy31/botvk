import { VK, Keyboard } from "vk-io";
import admin from "firebase-admin";
import http from "http";

console.log("=== VK REPORT BOT START ===");

// ================= КОНФИГУРАЦИЯ =================
// Убедитесь, что в .env есть VK_TOKEN, CHAT_ID, FIREBASE_KEY, PORT

const vk = new VK({
  token: process.env.VK_TOKEN,
  apiVersion: "5.199",
  // Увеличиваем тайм-аут для загрузки фото
  uploadTimeout: 10000 
});

// Логика CHAT_ID:
// Если введено число < 2000000000 (например 55), делаем из него peer_id беседы.
// Если введено число > 2000000000, оставляем как есть.
let CHAT_ID = Number(process.env.CHAT_ID);
if (CHAT_ID < 2000000000) {
  CHAT_ID = 2000000000 + CHAT_ID;
}

console.log("TARGET PEER ID:", CHAT_ID);

// ================= FIREBASE =================
// Парсим ключ. Если FIREBASE_KEY передан как строка JSON
let serviceAccount;
try {
    serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
} catch (e) {
    console.error("Ошибка парсинга FIREBASE_KEY. Проверьте формат JSON в .env");
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

    // Проверяем актуальность отчета
    const snap = await db.ref(`reports/${reportId}`).once("value");
    const report = snap.val();

    // Если отчета нет или он уже не "pending" (обработан)
    if (!report || report.status !== "pending") {
      return ctx.answer({
        type: "show_snackbar",
        text: "Этот отчет уже обработан!"
      });
    }

    // Получаем имя админа, нажавшего кнопку
    const [adminUser] = await vk.api.users.get({ user_ids: ctx.userId });
    const adminName = `${adminUser.first_name} ${adminUser.last_name}`;
    
    const newStatus = action === "ok" ? "approved" : "rejected";
    const statusText = action === "ok" ? "✅ ОДОБРЕНО" : "❌ ОТКЛОНЕНО";

    // 1. Обновляем статус в Firebase
    await db.ref(`reports/${reportId}`).update({
      status: newStatus,
      reviewedBy: adminName,
      reviewedAt: Date.now()
    });

    // 2. Если одобрено, начисляем баллы автору
    if (action === "ok") {
      await db.ref(`users/${report.author}`).transaction(u => {
        if (!u) return u;
        // Защита от NaN, если вдруг баллов не было
        u.score = (u.score || 0) + (Number(report.score) || 0); 
        return u;
      });
    }

    // 3. Редактируем сообщение в ВК (убираем кнопки, пишем итог)
    try {
        await vk.api.messages.edit({
            peer_id: CHAT_ID,
            message_id: report.vkMessageId,
            message: `${report.vkText}\n\n${statusText}\n👤 Проверил: ${adminName}`,
            attachment: report.vkAttachments, // Сохраняем фото при редактировании
            keyboard: Keyboard.builder().clear() // Очищаем клавиатуру
        });
    } catch (editErr) {
        console.error("Ошибка редактирования сообщения:", editErr.message);
    }

    // 4. Показываем всплывающее уведомление админу
    await ctx.answer({
      type: "show_snackbar",
      text: action === "ok" ? "Отчет одобрен" : "Отчет отклонен"
    });

  } catch (e) {
    console.error("CALLBACK ERROR:", e);
    try {
        await ctx.answer({ type: "show_snackbar", text: "Ошибка обработки" });
    } catch {}
  }
});

// Запускаем LongPoll
vk.updates.start().then(() => {
  console.log("VK LongPoll updates started");
}).catch(console.error);

// ================= СЛУШАТЕЛЬ НОВЫХ ОТЧЕТОВ =================
db.ref("reports").on("child_added", async (snap) => {
  try {
    const reportId = snap.key;
    const report = snap.val();

    // Если данных нет или у отчета УЖЕ есть статус (значит он старый/обработанный) — пропускаем
    if (!report || report.status) return;

    console.log(`New report detected: ${reportId} from ${report.author}`);

    // Формируем текст
    const text = `📝 НОВЫЙ ОТЧЕТ\n\n👤 Ник: ${report.author}\n🎖 Ранг: ${report.rank}\n📊 Баллов: ${report.score}\n📅 Дата: ${report.date}\n\n💬 Описание:\n${report.work}`;

    let attachments = [];

    // Загрузка фото (если есть)
    if (Array.isArray(report.imgs) && report.imgs.length > 0) {
      // Ограничиваем кол-во фото до 10 (лимит ВК)
      const imgsToLoad = report.imgs.slice(0, 10);
      
      // Загружаем параллельно для скорости
      const uploadPromises = imgsToLoad.map(async (base64String) => {
          try {
              // Убираем префикс data:image... если он есть
              const base64Data = base64String.replace(/^data:image\/\w+;base64,/, "");
              const buffer = Buffer.from(base64Data, 'base64');

              // ВСТРОЕННАЯ ЗАГРУЗКА VK-IO (намного надежнее fetch)
              const photo = await vk.upload.messagePhoto({
                  source: buffer,
                  peer_id: CHAT_ID 
              });
              
              return photo; // Возвращает объект attachment
          } catch (err) {
              console.error(`Ошибка загрузки фото для отчета ${reportId}:`, err.message);
              return null;
          }
      });

      const uploadedPhotos = await Promise.all(uploadPromises);
      // Фильтруем неудачные загрузки (null) и превращаем в строки attachments
      attachments = uploadedPhotos.filter(p => p !== null).map(p => p.toString());
    }

    // Кнопки
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

    // Отправка в беседу
    const sentMessage = await vk.api.messages.send({
      peer_id: CHAT_ID,
      random_id: Math.floor(Math.random() * 1000000000), // Явный random_id
      message: text,
      attachment: attachments.join(","),
      keyboard: keyboard
    });

    console.log(`Report sent to VK. Message ID: ${sentMessage}`);

    // Обновляем в БД (ставим статус pending, чтобы не отправлять повторно при перезапуске)
    await db.ref(`reports/${reportId}`).update({
      status: "pending",
      vkMessageId: sentMessage, // vk-io возвращает ID числа
      vkText: text,
      vkAttachments: attachments.join(",") // Сохраняем ID фоток для будущего редактирования
    });

  } catch (e) {
    console.error("VK SEND ERROR:", e);
  }
});

// ================= HTTP SERVER (чтобы хостинг не усыплял) =================
http.createServer((req, res) => {
  res.writeHead(200);
  res.end(`VK Bot is running. Chat ID: ${CHAT_ID}`);
}).listen(process.env.PORT || 3000);
