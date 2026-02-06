import { VK, Keyboard } from "vk-io";
import admin from "firebase-admin";
import fetch from "node-fetch";
import http from "http";

// =======================
// ИНИЦИАЛИЗАЦИЯ
// =======================
const vk = new VK({
    token: process.env.VK_TOKEN,
    apiVersion: "5.199",
    pollingGroupId: Number(process.env.VK_GROUP_ID)
});

const SITE_URL = "https://ваш-сайт.com";

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
        databaseURL: "https://modersekb-default-rtdb.firebaseio.com"
    });
}

const db = admin.database();
let isBotReady = false;

console.log("🚀 Бот запускается...");

// =======================
// КОМАНДЫ
// =======================

vk.updates.on("message_new", async (ctx) => {
    if (ctx.isOutbox || !ctx.text) return;
    const text = ctx.text.trim();

    if (text === "/bind") {
        await db.ref("settings/chatPeerId").set(ctx.peerId);
        return ctx.send(`✅ Беседа привязана! ID: ${ctx.peerId}`);
    }

    if (text === "/id") {
        return ctx.send(`peer_id: ${ctx.peerId}`);
    }

    if (text.toLowerCase().startsWith("/info")) {
        const nickRaw = text.replace(/^\/info\s*/i, "").trim();
        if (!nickRaw) return ctx.send("❗ Используй: /info Ник");

        const [usersSnap, reportsSnap] = await Promise.all([
            db.ref("users").once("value"),
            db.ref("reports").once("value")
        ]);

        const users = usersSnap.val() || {};
        const reports = reportsSnap.val() || {};
        const targetKey = Object.keys(users).find(k => k.toLowerCase() === nickRaw.toLowerCase());
        const userEntry = targetKey ? users[targetKey] : null;
        const userReports = Object.values(reports).filter(r => (r.author || "").toLowerCase() === nickRaw.toLowerCase());

        if (!userEntry && userReports.length === 0) {
            return ctx.send(`❌ Модератор "${nickRaw}" не найден.`);
        }

        const lastReport = userReports.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))[0];
        const avgScore = userReports.length ? Math.round(userReports.reduce((s, r) => s + (Number(r.score) || 0), 0) / userReports.length) : 0;

        const personalUrl = `${SITE_URL}/#profile?user=${encodeURIComponent(targetKey || nickRaw)}`;

        let message = `📋 ИНФОРМАЦИЯ\n`;
        message += `👤 Ник: ${targetKey || nickRaw}\n`;
        message += `📧 Почта: ${userEntry?.email || "нет"}\n`;
        message += `🎖 Роль: ${userEntry?.role || lastReport?.role || "нет"}\n`;
        if (userEntry?.rank) message += `🏢 Должность: ${userEntry.rank}\n`;
        if (userEntry?.score !== undefined) message += `📊 Баллы: ${userEntry.score}\n`;
        message += `📝 Отчетов: ${userReports.length}\n`;
        if (lastReport?.date) message += `📅 Последний отчет: ${lastReport.date}\n`;
        message += `📈 Средний балл: ${avgScore}\n`;
        if (userEntry?.lastSeen) message += `🕒 Последний вход: ${new Date(userEntry.lastSeen).toLocaleString()}`;

        return ctx.send({
            message: message,
            keyboard: Keyboard.builder()
                .inline()
                .urlButton({ label: "🌍 Открыть в таблице", url: personalUrl })
        });
    }
});

vk.updates.on("message_event", async (ctx) => {
    try {
        const payload = ctx.eventPayload;
        if (!payload || !payload.reportId) return;
        await ctx.answer().catch(() => {});

        const { reportId, action } = payload;
        const reportRef = db.ref(`reports/${reportId}`);
        const snap = await reportRef.once("value");
        const report = snap.val();

        if (!report || report.status !== "pending") return;

        const [adminUser] = await vk.api.users.get({ user_ids: ctx.userId });
        const adminName = `${adminUser.first_name} ${adminUser.last_name}`;
        const isApproved = action === "ok";

        if (isApproved && report.author) {
            await db.ref(`users/${report.author}/score`).transaction(c => (c || 0) + (Number(report.score) || 0));
        }

        await reportRef.update({
            status: isApproved ? "approved" : "rejected",
            checker: adminName,
            checkTime: Date.now()
        });

        const statusIcon = isApproved ? "✅ ОДОБРЕНО" : "❌ ОТКЛОНЕНО";
        await vk.api.messages.edit({
            peer_id: ctx.peerId,
            conversation_message_id: ctx.conversationMessageId,
            message: `${report.vkText}\n\n${statusIcon}\n👤 Проверил: ${adminName}`,
            keyboard: Keyboard.builder().inline().toString()
        });

    } catch (e) { console.error("Ошибка кнопок:", e); }
});

// =======================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// =======================

async function uploadImageToVK(imageUrl, peerId) {
    try {
        const response = await fetch(imageUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const buffer = await response.buffer();
        
        let mimeType = 'image/jpeg';
        if (imageUrl.toLowerCase().endsWith('.png')) mimeType = 'image/png';
        else if (imageUrl.toLowerCase().endsWith('.gif')) mimeType = 'image/gif';
        else if (imageUrl.toLowerCase().endsWith('.webp')) mimeType = 'image/webp';
        
        const photo = await vk.upload.messagePhoto({
            source: {
                value: buffer,
                contentType: mimeType,
                filename: `photo_${Date.now()}.${mimeType.split('/')[1]}`
            },
            peer_id: Number(peerId)
        });
        
        return photo.toString();
        
    } catch (error) {
        console.error(`[UPLOAD] Ошибка:`, error.message);
        return null;
    }
}

async function getChatId() {
    const peerIdSnap = await db.ref("settings/chatPeerId").once("value");
    return peerIdSnap.val();
}

// =======================
// ИНИЦИАЛИЗАЦИЯ ДАННЫХ
// =======================

// Запоминаем ID существующих пользователей и отчетов при запуске
let existingUsers = new Set();
let existingReports = new Set();

async function initializeExistingData() {
    console.log("[INIT] Загружаю существующие данные...");
    
    // Загружаем существующих пользователей
    const usersSnap = await db.ref("users").once("value");
    const users = usersSnap.val() || {};
    existingUsers = new Set(Object.keys(users));
    console.log(`[INIT] Загружено пользователей: ${existingUsers.size}`);
    
    // Загружаем существующие отчеты
    const reportsSnap = await db.ref("reports").once("value");
    const reports = reportsSnap.val() || {};
    existingReports = new Set(Object.keys(reports));
    console.log(`[INIT] Загружено отчетов: ${existingReports.size}`);
    
    isBotReady = true;
    console.log("[INIT] Бот готов к работе!");
}

// =======================
// ОБРАБОТКА НОВЫХ ДАННЫХ
// =======================

db.ref("users").on("child_added", async (snap) => {
    if (!isBotReady) return;
    
    const userId = snap.key;
    const userData = snap.val();
    
    // Проверяем, новый ли это пользователь
    if (existingUsers.has(userId)) {
        console.log(`[USER] Пользователь ${userId} уже существовал, пропускаем`);
        return;
    }
    
    // Добавляем в список существующих
    existingUsers.add(userId);
    
    // Если уже был уведомлен, пропускаем
    if (userData.vkNotified) {
        console.log(`[USER] Пользователь ${userId} уже был уведомлен`);
        return;
    }
    
    console.log(`[USER] Обрабатываю нового пользователя: ${userId}`);
    await processNewUser(userId, userData);
});

async function processNewUser(userId, userData) {
    try {
        const peerId = await getChatId();
        if (!peerId) return;

        let message = "";
        if (userData.role === 'pending') {
            message = `🆕 НОВАЯ ЗАЯВКА НА ВСТУПЛЕНИЕ\n\n` +
                     `👤 Ник: ${userData.nick || userId}\n` +
                     `📧 Почта: ${userData.email || "не указана"}\n` +
                     `🕒 Время: ${new Date(userData.lastSeen || Date.now()).toLocaleString()}\n` +
                     `\n✍️ Требуется одобрение\n` +
                     `Ссылка: ${SITE_URL}/#profile?user=${encodeURIComponent(userId)}`;
        } else {
            message = `👤 НОВЫЙ ПОЛЬЗОВАТЕЛЬ В СИСТЕМЕ\n\n` +
                     `Ник: ${userData.nick || userId}\n` +
                     `Роль: ${userData.role || "user"}\n` +
                     `Должность: ${userData.rank || "Не назначена"}\n` +
                     `\nДобро пожаловать! 🎉`;
        }
        
        await vk.api.messages.send({
            peer_id: Number(peerId),
            random_id: Math.floor(Math.random() * 2000000000),
            message: message
        });
        
        console.log(`✅ Уведомление о пользователе ${userId} отправлено`);
        
        await db.ref(`users/${userId}`).update({
            vkNotified: true,
            vkNotificationTime: Date.now()
        });
        
    } catch (error) {
        console.error(`❌ Ошибка:`, error);
    }
}

db.ref("reports").on("child_added", async (snap) => {
    if (!isBotReady) return;
    
    const reportId = snap.key;
    const report = snap.val();
    
    // Проверяем, новый ли это отчет
    if (existingReports.has(reportId)) {
        console.log(`[REPORT] Отчет ${reportId} уже существовал, пропускаем`);
        return;
    }
    
    // Добавляем в список существующих
    existingReports.add(reportId);
    
    // Если уже был обработан, пропускаем
    if (report.vkMessageId || report.botProcessed) {
        console.log(`[REPORT] Отчет ${reportId} уже был обработан`);
        return;
    }
    
    console.log(`[REPORT] Обрабатываю новый отчет ${reportId}`);
    await processNewReport(reportId, report);
});

async function processNewReport(reportId, report) {
    try {
        const peerId = await getChatId();
        if (!peerId) return;

        const text = 
            `📝 НОВЫЙ ОТЧЕТ\n\n` +
            `👤 Ник: ${report.author || "—"}\n` +
            `🔰 Должность: ${report.role || "—"}\n` +
            `📅 Дата: ${report.date || "—"}\n\n` +
            `🛠 Работа: ${report.work || "—"}\n` +
            `⚖️ Наказания: ${report.punishments || "Нет"}\n` +
            `📊 Баллы: ${report.score || 0}`;
        
        const attachments = [];
        
        if (report.imgs && Array.isArray(report.imgs)) {
            for (let i = 0; i < report.imgs.length; i++) {
                const imgData = report.imgs[i];
                
                if (typeof imgData === 'string' && imgData.startsWith('data:image')) {
                    try {
                        const base64Data = imgData.replace(/^data:image\/\w+;base64,/, '');
                        const buffer = Buffer.from(base64Data, 'base64');
                        
                        const mimeMatch = imgData.match(/^data:(image\/\w+);base64,/);
                        const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
                        
                        const photo = await vk.upload.messagePhoto({
                            source: {
                                value: buffer,
                                contentType: mimeType,
                                filename: `report_${reportId}_${i}.${mimeType.split('/')[1]}`
                            },
                            peer_id: Number(peerId)
                        });
                        
                        attachments.push(photo.toString());
                        
                    } catch (error) {
                        console.error(`Ошибка загрузки фото ${i+1}:`, error.message);
                    }
                }
            }
        }
        
        const keyboard = Keyboard.builder()
            .inline()
            .callbackButton({ 
                label: "✅ Одобрить", 
                payload: { reportId, action: "ok" }, 
                color: "positive" 
            })
            .callbackButton({ 
                label: "❌ Отказать", 
                payload: { reportId, action: "no" }, 
                color: "negative" 
            })
            .toString();
        
        const msgId = await vk.api.messages.send({
            peer_id: Number(peerId),
            random_id: Math.floor(Math.random() * 2000000000),
            message: text,
            attachment: attachments.join(','),
            keyboard: keyboard
        });
        
        console.log(`✅ Отчет ${reportId} отправлен`);
        
        await db.ref(`reports/${reportId}`).update({
            vkMessageId: msgId,
            vkText: text,
            status: "pending",
            processedAt: Date.now(),
            botProcessed: true
        });
        
    } catch (error) {
        console.error(`❌ Ошибка отчета ${reportId}:`, error);
    }
}

// =======================
// ЗАПУСК
// =======================

async function startBot() {
    try {
        // Инициализируем данные
        await initializeExistingData();
        
        // Запускаем VK бота
        await vk.updates.start();
        
        console.log('🤖 Бот успешно запущен');
        console.log('📊 Команды: /bind, /id, /info [ник]');
        
    } catch (error) {
        console.error('❌ Ошибка запуска:', error);
    }
}

startBot();

// Веб-сервер для проверки
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`✅ Бот работает\n📊 Пользователей: ${existingUsers.size}\n📝 Отчетов: ${existingReports.size}`);
}).listen(process.env.PORT || 3000);

console.log(`🌐 Сервер на порту ${process.env.PORT || 3000}`);
