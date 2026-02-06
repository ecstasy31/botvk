import { VK, Keyboard } from "vk-io";
import admin from "firebase-admin";
import http from "http";

// ================= НАСТРОЙКИ =================
const TARGET_CHAT_ID = 2000000086; // Твой ID беседы
const BOT_START_TIME = Date.now(); // Время запуска (чтобы игнорировать старое)

console.log("=== VK BOT STARTING ===");
console.log(`🕒 Время запуска: ${new Date(BOT_START_TIME).toLocaleTimeString()}`);

// ================= ИНИЦИАЛИЗАЦИЯ =================
const vk = new VK({
  token: process.env.VK_TOKEN,
  apiVersion: "5.199",
  pollingGroupId: Number(process.env.VK_GROUP_ID),
  uploadTimeout: 20000
});

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
} catch (e) {
  console.error("❌ Ошибка ключа Firebase. Проверь .env файл!");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://modersekb-default-rtdb.firebaseio.com"
});

const db = admin.database();
console.log("✅ База данных подключена");

// ================= КОМАНДЫ (ЧАТ И ЛС) =================

// 1. Приветствие при добавлении в беседу
vk.updates.on('chat_invite_user', async (ctx) => {
    if (ctx.eventMemberId === -Number(process.env.VK_GROUP_ID)) {
        await ctx.send("👋 Всем привет! Я бот-модератор.\nНапишите команду /start, чтобы я начал работу.");
    }
});

// 2. Обработка текстовых команд
vk.updates.on('message_new', async (ctx) => {
    if (!ctx.text) return;

    const text = ctx.text.trim();
    const lowerText = text.toLowerCase();

    // --- Команда /start ---
    if (lowerText === '/start') {
        return ctx.send(`🚀 Бот работает!\n🆔 ID этой беседы: ${ctx.peerId}\n(Целевой ID в настройках: ${TARGET_CHAT_ID})`);
    }

    // --- Команда !test (проверка жизни) ---
    if (lowerText === '!test') {
        return ctx.send("🟢 Я в сети и готов принимать отчеты.");
    }

    // --- Команда /info Никнейм ---
    if (lowerText.startsWith('/info ')) {
        const nickname = text.split(' ').slice(1).join(' '); // Берем всё после пробела
        if (!nickname) return ctx.send("❌ Укажите никнейм: /info NickName");

        try {
            // Ищем пользователя в базе users
            const snap = await db.ref(`users/${nickname}`).once('value');
            const user = snap.val();

            if (!user) {
                return ctx.send(`🚫 Пользователь "${nickname}" не найден в базе.`);
            }

            const infoMsg = `👤 Информация о: ${nickname}\n` +
                            `🔰 Роль: ${user.role || 'Не указана'}\n` +
                            `💰 Баллы: ${user.score || 0}\n` +
                            `⚠️ Выговоры: ${user.warns || 0}\n` +
                            `📄 Всего отчетов: ${user.reportsCount || 0}`;
            
            return ctx.send(infoMsg);

        } catch (e) {
            console.error(e);
            return ctx.send("❌ Ошибка при поиске данных.");
        }
    }
});

// ================= ОБРАБОТКА КНОПОК (CALLBACK) =================
vk.updates.on("message_event", async (ctx) => {
  try {
    const { reportId, action } = ctx.payload;
    if (!reportId) return;

    const snap = await db.ref(`reports/${reportId}`).once("value");
    const report = snap.val();

    // Проверка актуальности
    if (!report || report.status !== "pending") {
      return ctx.answer({ type: "show_snackbar", text: "⚠️ Отчет уже обработан!" });
    }

    // Данные админа
    const [adminUser] = await vk.api.users.get({ user_ids: ctx.userId });
    const adminName = `${adminUser.first_name} ${adminUser.last_name}`;
    
    const isApprove = action === "ok";
    const statusText = isApprove ? "✅ ОДОБРЕНО" : "❌ ОТКЛОНЕНО";

    // 1. Обновляем статус в БД
    await db.ref(`reports/${reportId}`).update({
      status: isApprove ? "approved" : "rejected",
      reviewedBy: adminName,
      reviewedAt: Date.now()
    });

    // 2. Начисляем баллы (Только если ОК)
    if (isApprove) {
        await db.ref(`users/${report.author}`).transaction((u) => {
            if (!u) u = { score: 0, reportsCount: 0 }; // Если юзера нет, создаем структуру
            u.score = (u.score || 0) + (Number(report.score) || 0);
            u.reportsCount = (u.reportsCount || 0) + 1;
            return u;
        });
    }

    // 3. Редактируем сообщение
    try {
      await vk.api.messages.edit({
        peer_id: TARGET_CHAT_ID,
        conversation_message_id: ctx.conversationMessageId,
        message: `${report.vkText}\n\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n${statusText}\n👤 Проверил: ${adminName}`,
        attachment: report.vkAttachments || "",
        keyboard: Keyboard.builder().clear()
      });
    } catch (err) { console.error("Ошибка редакта:", err.message); }

    await ctx.answer({ type: "show_snackbar", text: isApprove ? "Принято!" : "Отказано!" });

  } catch (e) {
    console.error("Callback Error:", e);
  }
});

// ================= СЛУШАТЕЛЬ НОВЫХ ОТЧЕТОВ =================
db.ref("reports").limitToLast(5).on("child_added", async (snap) => {
  try {
    const reportId = snap.key;
    const report = snap.val();

    if (!report) return;

    // --- ФИЛЬТРЫ ---
    // 1. Если уже обработан или отправлен
    if (report.status || report.vkMessageId) return;

    // 2. Если отчет старше момента запуска бота (защита от спама старым)
    // ВАЖНО: На сайте должен отправляться timestamp!
    if (report.timestamp && report.timestamp < BOT_START_TIME) {
        // console.log(`⏩ Пропуск старого отчета: ${reportId}`);
        return;
    }
    
    console.log(`📩 ОБРАБОТКА ОТЧЕТА: ${report.author}`);

    // Текст сообщения
    const text = 
`📝 НОВЫЙ ОТЧЕТ

👤 Ник: ${report.nickname || report.author}
🔰 Должность: ${report.role || "Не указана"}
📊 Баллы: ${report.score || 0}
📅 Дата: ${report.date}

🛠 Работа: ${report.work}
⚖️ Наказаний: ${report.punishments || 0}`;

    let attachments = [];

    // Загрузка фото (поддержка URL и Base64)
    if (report.photoUrl && report.photoUrl.startsWith('http')) {
        try {
            const photo = await vk.upload.messagePhoto({
                source: { value: report.photoUrl },
                peer_id: TARGET_CHAT_ID
            });
            attachments.push(photo.toString());
        } catch(e) { console.error("Ошибка фото URL:", e.message); }
    } 
    else if (Array.isArray(report.imgs)) {
        for (const b64 of report.imgs) {
            try {
                const cleanB64 = b64.replace(/^data:image\/\w+;base64,/, "");
                const photo = await vk.upload.messagePhoto({
                    source: Buffer.from(cleanB64, 'base64'),
                    peer_id: TARGET_CHAT_ID
                });
                attachments.push(photo.toString());
            } catch(e) {}
        }
    }

    // Клавиатура
    const keyboard = Keyboard.builder().inline()
      .callbackButton({ label: "✅ Одобрить", payload: { reportId, action: "ok" }, color: Keyboard.POSITIVE_COLOR })
      .callbackButton({ label: "❌ Отказать", payload: { reportId, action: "no" }, color: Keyboard.NEGATIVE_COLOR });

    // Отправка
    const sent = await vk.api.messages.send({
        peer_id: TARGET_CHAT_ID,
        random_id: Date.now(),
        message: text,
        attachment: attachments.join(','),
        keyboard: keyboard
    });

    console.log(`✅ ОТПРАВЛЕНО В БЕСЕДУ! ID: ${sent}`);

    // Помечаем в базе как "отправленное" (pending)
    await db.ref(`reports/${reportId}`).update({
        status: "pending",
        vkMessageId: sent,
        vkText: text,
        vkAttachments: attachments.join(',')
    });

  } catch (e) {
    console.error("❌ ОШИБКА ОТПРАВКИ:", e);
  }
});

vk.updates.start().then(() => console.log("🚀 Бот запущен и слушает команды!"));

http.createServer((_, res) => res.end("Bot is working")).listen(process.env.PORT || 3000);
