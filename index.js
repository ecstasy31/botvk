import { VK, Keyboard } from "vk-io";
import admin from "firebase-admin";
import http from "http";

// ================= НАСТРОЙКИ =================
// Время запуска бота. Все отчеты, созданные РАНЬШЕ этого времени, будут проигнорированы.
const BOT_START_TIME = Date.now(); 

console.log("=== VK REPORT BOT ЗАПУЩЕН ===");

// Инициализация VK
const vk = new VK({
  token: process.env.VK_TOKEN,
  apiVersion: "5.199",
  pollingGroupId: Number(process.env.VK_GROUP_ID), // ID группы нужен для корректной работы событий
  uploadTimeout: 15000
});

// Целевая беседа
const TARGET_PEER_ID = 2000000086;

// Инициализация Firebase
let serviceAccount;
try {
  // Если ключ в .env вставлен одной строкой
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
} catch (e) {
  console.error("❌ ОШИБКА: Неверный формат JSON в FIREBASE_KEY");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://modersekb-default-rtdb.firebaseio.com"
});

const db = admin.database();
console.log("✅ Firebase подключен");

// ================= 1. ОБРАБОТКА КНОПОК (CALLBACK) =================
vk.updates.on("message_event", async (ctx) => {
  try {
    const { reportId, action } = ctx.payload;

    // Ищем отчет в базе
    const snap = await db.ref(`reports/${reportId}`).once("value");
    const report = snap.val();

    // Защита: если отчет удален или уже имеет статус (кроме pending)
    if (!report || (report.status !== "pending" && report.status !== undefined)) {
      return ctx.answer({
        type: "show_snackbar",
        text: "⚠️ Этот отчет уже обработан кем-то другим!"
      });
    }

    // Получаем имя того, кто нажал кнопку
    const [adminUser] = await vk.api.users.get({ user_ids: ctx.userId });
    const adminName = `${adminUser.first_name} ${adminUser.last_name}`;
    
    // Определяем статус
    const isApprove = action === "ok";
    const newStatus = isApprove ? "approved" : "rejected";
    const statusEmoji = isApprove ? "✅" : "❌";
    const statusText = isApprove ? "ОДОБРЕНО" : "ОТКЛОНЕНО";

    // --- НАЧИСЛЕНИЕ БАЛЛОВ (ТОЛЬКО ЕСЛИ ОДОБРЕНО) ---
    if (isApprove) {
        // Транзакция гарантирует, что баллы не перезапишутся при одновременном доступе
        // Ищем пользователя по никнейму (предполагаем, что users хранятся по ID или никам)
        // ВАЖНО: На сайте report.author должен совпадать с ключом в users, либо нужно искать.
        // Здесь предполагаем, что report.author - это ключ пользователя в БД.
        // Если report.author это просто текст "NickName", а в базе users/ID, то код нужно менять.
        // Но пока делаем как в твоем запросе: users/{report.author}
        
        await db.ref(`users/${report.author}`).transaction((userData) => {
            if (!userData) {
                // Если юзера нет в базе, можно создать или игнорировать.
                // Вернем null, чтобы не создавать мусор, или создадим структуру.
                // Лучше вернуть userData как есть, если его нет.
                return userData; 
            }
            // Добавляем баллы
            userData.score = (userData.score || 0) + (Number(report.score) || 0);
            return userData;
        });
        console.log(`💰 Начислены баллы пользователю ${report.author}`);
    }

    // --- ОБНОВЛЕНИЕ СТАТУСА ОТЧЕТА ---
    await db.ref(`reports/${reportId}`).update({
      status: newStatus,
      reviewedBy: adminName,
      reviewedAt: admin.database.ServerValue.TIMESTAMP
    });

    // --- РЕДАКТИРОВАНИЕ СООБЩЕНИЯ В ВК ---
    try {
      await vk.api.messages.edit({
        peer_id: TARGET_PEER_ID,
        message_id: ctx.conversationMessageId, // или report.vkMessageId
        message: `${report.vkText}\n\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n${statusEmoji} ИТОГ: ${statusText}\n👤 Проверил: ${adminName}`,
        attachment: report.vkAttachments || "",
        keyboard: Keyboard.builder().clear() // Удаляем кнопки
      });
    } catch (err) {
      console.error("⚠️ Не удалось отредактировать сообщение (возможно оно старое):", err.message);
    }

    // Уведомление (всплывашка) админу
    await ctx.answer({
      type: "show_snackbar",
      text: isApprove ? `✅ Принято (+${report.score} баллов)` : "❌ Отказано"
    });

  } catch (e) {
    console.error("CALLBACK ERROR:", e);
    try { await ctx.answer(); } catch(err){} // Чтобы кнопка перестала крутиться
  }
});

// ================= 2. СЛУШАТЕЛЬ НОВЫХ ОТЧЕТОВ =================
db.ref("reports").limitToLast(10).on("child_added", async (snap) => {
  try {
    const reportId = snap.key;
    const report = snap.val();

    // --- ФИЛЬТРЫ (ЧТОБЫ НЕ СПАМИЛ СТАРЫМ) ---
    
    // 1. Если отчет пустой
    if (!report) return;

    // 2. Если у отчета уже есть статус (значит он обработан)
    if (report.status && report.status !== "pending") return;

    // 3. Если отчет уже был отправлен в ВК (есть ID сообщения)
    if (report.vkMessageId) return;

    // 4. САМОЕ ВАЖНОЕ: Фильтр по времени.
    // Если timestamp отчета меньше времени запуска бота — игнорируем.
    // (Если timestamp нет, считаем старым и игнорируем для безопасности)
    if (!report.timestamp || report.timestamp < BOT_START_TIME) {
        // console.log(`Скип старого отчета: ${reportId}`);
        return;
    }

    console.log(`📩 Новый отчет обнаружен: ${report.author}`);

    // Формируем текст
    const text = 
`📝 НОВЫЙ ОТЧЕТ

👤 Ник: ${report.nickname || report.author}
🔰 Должность: ${report.role || report.rank || "Не указана"}
📊 Баллы за отчет: ${report.score || 0}
📅 Дата: ${report.date}

🛠 Проделанная работа:
${report.work}

⚖️ Наказаний: ${report.punishments || 0}`;

    let attachments = [];

    // --- ЗАГРУЗКА ФОТО ---
    // Если пришла ссылка (URL)
    if (report.photoUrl && report.photoUrl.startsWith('http')) {
        try {
            const photo = await vk.upload.messagePhoto({
                source: { value: report.photoUrl },
                peer_id: TARGET_PEER_ID
            });
            attachments.push(photo.toString());
        } catch (e) {
            console.error("Ошибка загрузки фото по ссылке:", e.message);
        }
    }
    // Если пришел base64 (массив imgs, как в твоем примере)
    else if (Array.isArray(report.imgs) && report.imgs.length > 0) {
      const uploadPromises = report.imgs.map(async (base64Str) => {
        try {
          const base64Data = base64Str.replace(/^data:image\/\w+;base64,/, "");
          const buffer = Buffer.from(base64Data, 'base64');
          const photo = await vk.upload.messagePhoto({
            source: buffer,
            peer_id: TARGET_PEER_ID
          });
          return photo.toString();
        } catch (err) {
          console.error("Ошибка фото (base64):", err.message);
          return null;
        }
      });
      const results = await Promise.all(uploadPromises);
      attachments = [...attachments, ...results.filter(Boolean)];
    }

    // --- КЛАВИАТУРА ---
    const keyboard = Keyboard.builder()
      .inline()
      .callbackButton({
        label: "✅ Одобрить",
        payload: { reportId, action: "ok" },
        color: Keyboard.POSITIVE_COLOR // Зеленая
      })
      .callbackButton({
        label: "❌ Отказать",
        payload: { reportId, action: "no" },
        color: Keyboard.NEGATIVE_COLOR // Красная
      });

    // --- ОТПРАВКА ---
    const sentMsg = await vk.api.messages.send({
      peer_id: TARGET_PEER_ID,
      random_id: Date.now(),
      message: text,
      attachment: attachments.join(","),
      keyboard: keyboard
    });

    console.log(`✅ Отправлено в беседу (msg_id: ${sentMsg})`);

    // Сохраняем ID сообщения в базу, чтобы бот знал, что это сообщение связано с этим отчетом
    // И ставим статус pending (ожидает проверки)
    await db.ref(`reports/${reportId}`).update({
      status: "pending",
      vkMessageId: sentMsg,
      vkText: text, // Сохраняем текст, чтобы потом вернуть его при редактировании
      vkAttachments: attachments.join(",") 
    });

  } catch (e) {
    console.error("SEND ERROR:", e);
  }
});

// Запуск Polling
vk.updates.start().catch(console.error);

// HTTP сервер (чтобы Render не усыплял бота сразу, если ты используешь UptimeRobot)
http.createServer((_, res) => {
  res.writeHead(200);
  res.end(`Bot is alive. Start time: ${new Date(BOT_START_TIME).toISOString()}`);
}).listen(process.env.PORT || 3000);
