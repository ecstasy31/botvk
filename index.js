import { VK, Keyboard } from "vk-io";
import admin from "firebase-admin";
import http from "http";

// ================= НАСТРОЙКИ =================
const TARGET_PEER_ID = 2000000086; 
const BOT_START_TIME = Date.now(); // Игнорируем всё, что было создано до запуска

console.log("=== VK MODERATOR BOT STARTED ===");

const vk = new VK({
    token: process.env.VK_TOKEN,
    apiVersion: "5.199",
    pollingGroupId: Number(process.env.VK_GROUP_ID)
});

// Инициализация Firebase
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://modersekb-default-rtdb.firebaseio.com"
});
const db = admin.database();

// ================= КОМАНДЫ =================
vk.updates.on('message_new', async (ctx) => {
    if (!ctx.text || ctx.isOutbox) return;

    const text = ctx.text.trim();
    const [cmd, ...args] = text.split(' ');
    const lowerCmd = cmd.toLowerCase();

    // 1. Команда /start
    if (lowerCmd === '/start') {
        return ctx.send(`🚀 Бот системы отчетности запущен!\n🆔 ID этого чата: ${ctx.peerId}\n📡 Мониторинг базы: ВКЛЮЧЕН`);
    }

    // 2. Команда !test
    if (lowerCmd === '!test') {
        return ctx.send("🟢 Проверка связи пройдена. Я вижу сообщения.");
    }

    // 3. Команда /info [Ник]
    if (lowerCmd === '/info') {
        const nickname = args.join(' ');
        if (!nickname) return ctx.send("⚠️ Напишите ник: /info Nick_Name");

        const snap = await db.ref(`users/${nickname}`).once('value');
        const user = snap.val();

        if (!user) return ctx.send(`🚫 Пользователь ${nickname} не найден в базе.`);

        return ctx.send(
            `📊 СТАТИСТИКА: ${nickname}\n` +
            `━━━━━━━━━━━━━━━━\n` +
            `💰 Баллы: ${user.score || 0}\n` +
            `🔰 Роль: ${user.role || "Не указана"}\n` +
            `⚠️ Выговоры: ${user.warns || 0}\n` +
            `📄 Отчетов принято: ${user.reportsCount || 0}`
        );
    }
});

// ================= ОБРАБОТКА КНОПОК =================
vk.updates.on("message_event", async (ctx) => {
    try {
        const { reportId, action } = ctx.payload;
        const snap = await db.ref(`reports/${reportId}`).once("value");
        const report = snap.val();

        if (!report || report.status !== "pending") {
            return ctx.answer({ type: "show_snackbar", text: "⚠️ Отчет уже проверен!" });
        }

        const [adminInfo] = await vk.api.users.get({ user_ids: ctx.userId });
        const adminName = `${adminInfo.first_name} ${adminInfo.last_name}`;
        
        const isApprove = action === "ok";
        
        // 1. Если ОДОБРЕНО - начисляем баллы и +1 к счетчику
        if (isApprove) {
            await db.ref(`users/${report.author}`).transaction((u) => {
                if (!u) u = { score: 0, reportsCount: 0 };
                u.score = (u.score || 0) + (Number(report.score) || 0);
                u.reportsCount = (u.reportsCount || 0) + 1;
                return u;
            });
        }

        // 2. Обновляем статус в базе
        await db.ref(`reports/${reportId}`).update({
            status: isApprove ? "approved" : "rejected",
            checkedBy: adminName
        });

        // 3. Редактируем сообщение (удаляем кнопки)
        await vk.api.messages.edit({
            peer_id: TARGET_PEER_ID,
            conversation_message_id: ctx.conversationMessageId,
            message: `${report.vkText}\n\n━━━━━━━━━━━━━━━━\n${isApprove ? "✅ ОДОБРЕНО" : "❌ ОТКЛОНЕНО"}\n👤 Проверил: ${adminName}`,
            attachment: report.vkAttachments || "",
            keyboard: Keyboard.builder().clear()
        });

        return ctx.answer({ type: "show_snackbar", text: isApprove ? "✅ Одобрено" : "❌ Отказано" });

    } catch (e) {
        console.error("Кнопки Error:", e);
    }
});

// ================= СЛУШАТЕЛЬ НОВЫХ ОТЧЕТОВ =================
db.ref("reports").on("child_added", async (snap) => {
    try {
        const reportId = snap.key;
        const report = snap.val();

        // ФИЛЬТРЫ
        if (!report || report.vkMessageId) return; // Уже отправлен
        if (!report.timestamp || report.timestamp < BOT_START_TIME) return; // Старый

        console.log(`📩 Новый отчет от ${report.author}`);

        const text = 
`📝 НОВЫЙ ОТЧЕТ

👤 Ник: ${report.nickname}
🔰 Роль: ${report.role}
📅 Дата: ${report.date}

🛠 Работа:
${report.work}

📊 Будет начислено: ${report.score} баллов`;

        let attach = "";
        if (report.photoUrl && report.photoUrl.startsWith('http')) {
            try {
                const photo = await vk.upload.messagePhoto({
                    source: { value: report.photoUrl },
                    peer_id: TARGET_PEER_ID
                });
                attach = photo.toString();
            } catch (e) { console.error("Фото ошибка:", e.message); }
        }

        const keyboard = Keyboard.builder().inline()
            .callbackButton({ label: "Одобрить", payload: { reportId, action: "ok" }, color: "positive" }) // Зеленая
            .callbackButton({ label: "Отказать", payload: { reportId, action: "no" }, color: "negative" }); // Красная

        const sent = await vk.api.messages.send({
            peer_id: TARGET_PEER_ID,
            random_id: Date.now(),
            message: text,
            attachment: attach,
            keyboard
        });

        // Сохраняем ID сообщения, чтобы потом его редактировать
        await db.ref(`reports/${reportId}`).update({
            vkMessageId: sent,
            vkText: text,
            vkAttachments: attach
        });

    } catch (e) {
        console.error("Ошибка отправки отчета:", e);
    }
});

// Запуск
vk.updates.start().then(() => console.log("🚀 Поллинг запущен!"));
http.createServer((req, res) => res.end("Bot Online")).listen(process.env.PORT || 3000);
