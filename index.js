import { VK, Keyboard } from "vk-io";
import admin from "firebase-admin";
import fetch from "node-fetch";
import http from "http";

// =======================
// ⚙️ КОНФИГУРАЦИЯ
// =======================
const vk = new VK({
    token: process.env.VK_TOKEN,
    apiVersion: "5.199",
    pollingGroupId: Number(process.env.VK_GROUP_ID)
});

// Инициализация Firebase
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
        databaseURL: "https://modersekb-default-rtdb.firebaseio.com"
    });
}

const db = admin.database();
const SITE_URL = "https://ecstasy31.github.io/moderation-panel/?clckid=dd788c52";
let isBotReady = false; // Флаг для игнорирования старых данных при старте

// Кеши для защиты от дублей
const processedReports = new Set();
const processedPurchases = new Set();
const processedSpins = new Set();

// =======================
// 🛠 ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// =======================

async function getChatId() {
    const snap = await db.ref("settings/chatPeerId").once("value");
    return snap.val();
}

// =======================
// 1️⃣ МАГАЗИН И ПОКУПКИ
// =======================

db.ref("shop_purchases").on("child_added", async (snap) => {
    if (!isBotReady) return; // Игнорируем старые при запуске
    
    const purchaseId = snap.key;
    const data = snap.val();
    
    if (processedPurchases.has(purchaseId)) return;
    processedPurchases.add(purchaseId);

    try {
        const peerId = await getChatId();
        if (!peerId) return;

        const message = 
            `🛍 НОВАЯ ПОКУПКА\n` +
            `👤 Кто: ${data.user || "Неизвестно"}\n` +
            `📦 Товар: ${data.item}\n` +
            `💰 Цена: ${data.price} 💎\n` +
            `⏰ Время: ${new Date(data.timestamp || Date.now()).toLocaleTimeString('ru-RU')}\n\n` +
            `🔔 Владелец: @id713635121 (Проверь выдачу)`;

        await vk.api.messages.send({
            peer_id: Number(peerId),
            random_id: 0,
            message: message
        });
        console.log(`[SHOP] Покупка ${purchaseId} отправлена`);
    } catch (e) {
        console.error(`[SHOP ERROR]`, e);
    }
});

// =======================
// 2️⃣ РУЛЕТКА (КАЗИНО)
// =======================

db.ref("roulette_spins").on("child_added", async (snap) => {
    if (!isBotReady) return;

    const spinId = snap.key;
    const data = snap.val();

    if (processedSpins.has(spinId)) return;
    processedSpins.add(spinId);

    try {
        const peerId = await getChatId();
        if (!peerId) return;

        const message = 
            `🎰 КАЗИНО / РУЛЕТКА\n` +
            `👤 Игрок: ${data.user || "Аноним"}\n` +
            `🎲 Выпало: ${data.prize || "Ничего"}\n` +
            `🕒 Время: ${new Date(data.timestamp || Date.now()).toLocaleTimeString('ru-RU')}`;

        await vk.api.messages.send({
            peer_id: Number(peerId),
            random_id: 0,
            message: message
        });
        console.log(`[CASINO] Прокрутка ${spinId} отправлена`);
    } catch (e) {
        console.error(`[CASINO ERROR]`, e);
    }
});

// =======================
// 3️⃣ ОБРАБОТКА ОТЧЕТОВ (ОСНОВНАЯ)
// =======================

db.ref("reports").on("child_added", async (snap) => {
    if (!isBotReady) return;

    const reportId = snap.key;
    const report = snap.val();

    // Проверка на дубли и уже обработанные ботом записи
    if (processedReports.has(reportId) || report.botProcessed) return;
    processedReports.add(reportId);

    // Если это служебное обновление, пропускаем
    if (!report.author || !report.work) return;

    try {
        const peerId = await getChatId();
        if (!peerId) return;

        // --- 3.1 ОТПРАВКА ОТЧЕТА АДМИНАМ ---
        
        const text = 
            `📝 НОВЫЙ ОТЧЕТ\n\n` +
            `👤 Ник: ${report.author}\n` +
            `🔰 Роль: ${report.role || "—"}\n` +
            `🛠 Работа: ${report.work}\n` +
            `⚖️ Наказания: ${report.punishments || "Нет"}\n` +
            `📊 Баллы: ${report.score || 0}`;

        const attachments = [];

        // Загрузка фото (макс 10)
        if (report.imgs && Array.isArray(report.imgs)) {
            const maxPhotos = Math.min(report.imgs.length, 10);
            for (let i = 0; i < maxPhotos; i++) {
                const imgData = report.imgs[i];
                if (typeof imgData === 'string' && imgData.startsWith('data:image')) {
                    try {
                        const base64Data = imgData.replace(/^data:image\/\w+;base64,/, '');
                        const buffer = Buffer.from(base64Data, 'base64');
                        const photo = await vk.upload.messagePhoto({
                            source: { value: buffer },
                            peer_id: Number(peerId)
                        });
                        attachments.push(photo.toString());
                    } catch (err) {
                        console.error(`[PHOTO] Ошибка загрузки фото ${i}:`, err.message);
                    }
                }
            }
        }

        const keyboard = Keyboard.builder().inline()
            .callbackButton({ label: "✅ Одобрить", payload: { reportId, action: "ok" }, color: "positive" })
            .callbackButton({ label: "❌ Отказать", payload: { reportId, action: "no" }, color: "negative" });

        const msgId = await vk.api.messages.send({
            peer_id: Number(peerId),
            random_id: 0,
            message: text,
            attachment: attachments.join(','),
            keyboard: keyboard
        });

        // Помечаем в БД, что бот обработал этот отчет
        await db.ref(`reports/${reportId}`).update({
            botProcessed: true,
            vkMessageId: msgId
        });

        // --- 3.2 АВТО-АНАЛИЗ (ОТДЕЛЬНОЕ СООБЩЕНИЕ) ---
        
        setTimeout(async () => {
            const issues = [];
            const workLen = (report.work || "").length;
            const imgCount = (report.imgs || []).length;
            const score = Number(report.score) || 0;

            if (workLen < 50) issues.push("— Слишком короткое описание (< 50 симв.)");
            if (imgCount === 0) issues.push("— Нет доказательств (фото)");
            if (score > 8 && imgCount < 2) issues.push("— Подозрение: высокий балл и мало фото");

            let reviewText = `🧠 Авто-анализ отчёта\n👤 Ник: ${report.author}\n\n`;
            
            if (issues.length > 0) {
                reviewText += `⚠️ ЗАМЕЧАНИЯ:\n${issues.join("\n")}`;
            } else {
                reviewText += `✅ Отчёт выглядит качественно и соответствует нормам.`;
            }

            await vk.api.messages.send({
                peer_id: Number(peerId),
                random_id: 0,
                message: reviewText,
                reply_to: msgId // Ответ на сообщение с отчетом
            });
            console.log(`[AUTO-REVIEW] Отзыв отправлен для ${reportId}`);
        }, 2000); // Задержка 2 сек для красоты

    } catch (e) {
        console.error(`[REPORT ERROR]`, e);
    }
});

// =======================
// 4️⃣ КНОПКИ (ОДОБРЕНИЕ/ОТКАЗ)
// =======================

vk.updates.on("message_event", async (ctx) => {
    try {
        const { reportId, action } = ctx.eventPayload || {};
        if (!reportId) return;

        await ctx.answer();

        const reportRef = db.ref(`reports/${reportId}`);
        const snap = await reportRef.once("value");
        const report = snap.val();

        if (!report || report.status !== "pending") return;

        const [adminUser] = await vk.api.users.get({ user_ids: ctx.userId });
        const adminName = `${adminUser.first_name} ${adminUser.last_name}`;
        const isApproved = action === "ok";

        // Начисление баллов
        if (isApproved && report.author) {
            await db.ref(`users/${report.author}/score`).transaction(s => (s || 0) + (Number(report.score) || 0));
        }

        await reportRef.update({
            status: isApproved ? "approved" : "rejected",
            checker: adminName
        });

        // Обновление сообщения
        const newText = 
            `📝 ОТЧЕТ ${isApproved ? 'ОДОБРЕН ✅' : 'ОТКЛОНЕН ❌'}\n` +
            `👤 Ник: ${report.author}\n` +
            `📊 Баллы: ${report.score}\n` +
            `🛠 Работа: ${report.work}\n\n` +
            `👤 Проверил: ${adminName}`;

        await vk.api.messages.edit({
            peer_id: ctx.peerId,
            conversation_message_id: ctx.conversationMessageId,
            message: newText,
            keyboard: Keyboard.builder().inline().toString() // Убираем кнопки
            // attachment не трогаем, они останутся
        });

    } catch (e) {
        console.error("Ошибка кнопок:", e);
    }
});

// =======================
// 5️⃣ КОМАНДЫ ЧАТА
// =======================

vk.updates.on("message_new", async (ctx) => {
    if (ctx.isOutbox || !ctx.text) return;
    const text = ctx.text.trim();

    if (text === "/bind") {
        await db.ref("settings/chatPeerId").set(ctx.peerId);
        return ctx.send(`✅ Беседа привязана! ID: ${ctx.peerId}`);
    }

    if (text === "/id") return ctx.send(`ID: ${ctx.peerId}`);

    if (text.toLowerCase().startsWith("/info")) {
        const nick = text.replace("/info", "").trim();
        if(!nick) return ctx.send("Укажите ник.");
        
        // Поиск пользователя (упрощенно)
        const usersSnap = await db.ref("users").once("value");
        const users = usersSnap.val() || {};
        const user = users[nick];

        if (!user) return ctx.send("Не найден.");
        
        ctx.send(
            `👤 ${nick}\n` +
            `📊 Баллы: ${user.score || 0}\n` +
            `🏢 Ранг: ${user.rank || "Нет"}\n` +
            `🔗 ${SITE_URL}/#profile?user=${encodeURIComponent(nick)}`
        );
    }
});

// =======================
// 🚀 ЗАПУСК
// =======================

async function start() {
    // 1. Загружаем ключи существующих данных, чтобы не триггерить на старое
    console.log("Загрузка БД...");
    
    const [reportsS, purchasesS, spinsS] = await Promise.all([
        db.ref("reports").limitToLast(100).once("value"),
        db.ref("shop_purchases").limitToLast(50).once("value"),
        db.ref("roulette_spins").limitToLast(50).once("value")
    ]);

    if (reportsS.val()) Object.keys(reportsS.val()).forEach(k => processedReports.add(k));
    if (purchasesS.val()) Object.keys(purchasesS.val()).forEach(k => processedPurchases.add(k));
    if (spinsS.val()) Object.keys(spinsS.val()).forEach(k => processedSpins.add(k));

    isBotReady = true;
    console.log(`Бот готов! Игнорирую старых записей: ${processedReports.size}`);

    await vk.updates.start();
    console.log("VK Polling запущен");
}

start();

// Health check для хостинга
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Bot is running');
}).listen(process.env.PORT || 3000);
