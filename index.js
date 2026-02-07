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

const SITE_URL = "https://ecstasy31.github.io/moderation-panel/?clckid=dd788c52";

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
// ДЛЯ ЗАЩИТЫ ОТ ДУБЛИКАТОВ
// =======================

// Множества для защиты от дубликатов
const processedPurchases = new Set();
const processedReportsForReview = new Set();
let existingUsers = new Set();
let existingReports = new Set();

// =======================
// 1️⃣ УВЕДОМЛЕНИЕ О ПОКУПКЕ В МАГАЗИНЕ
// =======================

// Обработчик покупок
db.ref("shop_purchases").on("child_added", async (snap) => {
    try {
        const purchaseId = snap.key;
        const purchase = snap.val();
        
        // Защита от дубликатов
        if (processedPurchases.has(purchaseId)) {
            console.log(`[SHOP] Покупка ${purchaseId} уже обработана`);
            return;
        }
        
        // Проверяем обязательные поля
        if (!purchase.user || !purchase.item || !purchase.price) {
            console.log(`[SHOP] Некорректные данные покупки ${purchaseId}`);
            return;
        }
        
        processedPurchases.add(purchaseId);
        
        // Получаем ID беседы
        const peerIdSnap = await db.ref("settings/chatPeerId").once("value");
        const peerId = peerIdSnap.val();
        
        if (!peerId) {
            console.log("[SHOP] Беседа не привязана (/bind)");
            return;
        }
        
        // Форматируем время
        const timestamp = purchase.timestamp || Date.now();
        const timeStr = new Date(timestamp).toLocaleString("ru-RU");
        
        // Формируем сообщение
        const message = `🛒 ПОКУПКА В МАГАЗИНЕ\n\n` +
                       `👤 Модератор: ${purchase.user}\n` +
                       `🎁 Товар: ${purchase.item}\n` +
                       `💰 Цена: ${purchase.price} баллов\n` +
                       `🕒 Время: ${timeStr}\n\n` +
                       `@id713635121(Владелец), выдай товар`;
        
        // Отправляем сообщение
        await vk.api.messages.send({
            peer_id: Number(peerId),
            random_id: Math.floor(Math.random() * 2000000000),
            message: message
        });
        
        console.log(`✅ Уведомление о покупке ${purchaseId} отправлено`);
        
        // Помечаем как обработанное (опционально)
        await db.ref(`shop_purchases/${purchaseId}`).update({
            botNotified: true,
            notificationTime: Date.now()
        });
        
    } catch (error) {
        console.error(`❌ Ошибка обработки покупки:`, error);
    }
});

// =======================
// 2️⃣ АВТО-ОЦЕНКА ОТЧЁТА (ТОЛЬКО ОТЗЫВ)
// =======================

// Функция анализа отчета
function analyzeReport(report) {
    const issues = [];
    
    // Проверка длины текста
    if (!report.work || report.work.length < 50) {
        issues.push("— Мало описания работы");
    }
    
    // Проверка наличия фото
    if (!report.imgs || !Array.isArray(report.imgs) || report.imgs.length === 0) {
        issues.push("— Нет доказательств (фото)");
    }
    
    // Проверка на подозрительные отчеты
    const score = Number(report.score) || 0;
    const photoCount = report.imgs ? report.imgs.length : 0;
    
    if (score > 8 && photoCount < 2) {
        issues.push("— Высокие баллы при малом количестве фото");
    }
    
    // Формируем финальный отзыв
    if (issues.length === 0) {
        return "✅ Отчёт выглядит качественно и соответствует стандартам";
    } else {
        return `⚠️ Замечания:\n${issues.join('\n')}`;
    }
}

// Обработчик для авто-оценки
db.ref("reports").on("child_added", async (snap) => {
    try {
        const reportId = snap.key;
        const report = snap.val();
        
        // Защита от дубликатов для авто-оценки
        if (processedReportsForReview.has(reportId)) {
            console.log(`[AUTO-REVIEW] Отчет ${reportId} уже обработан`);
            return;
        }
        
        // Игнорируем старые отчеты (старше 1 часа)
        const reportTime = report.timestamp || Date.now();
        if (Date.now() - reportTime > 3600000) {
            console.log(`[AUTO-REVIEW] Пропускаем старый отчет ${reportId}`);
            processedReportsForReview.add(reportId);
            return;
        }
        
        // Проверяем, что отчет в статусе pending
        if (report.status && report.status !== "pending") {
            console.log(`[AUTO-REVIEW] Отчет ${reportId} уже проверен`);
            processedReportsForReview.add(reportId);
            return;
        }
        
        processedReportsForReview.add(reportId);
        
        // Получаем ID беседы
        const peerIdSnap = await db.ref("settings/chatPeerId").once("value");
        const peerId = peerIdSnap.val();
        
        if (!peerId) {
            console.log("[AUTO-REVIEW] Беседа не привязана");
            return;
        }
        
        // Анализ отчета
        const feedback = analyzeReport(report);
        
        // Формируем отзыв
        const message = `🧠 АВТО-АНАЛИЗ ОТЧЕТА\n\n` +
                       `👤 Ник: ${report.author || "Не указан"}\n` +
                       `📊 Баллы: ${report.score || 0}\n\n` +
                       `${feedback}`;
        
        // Отправляем отзыв отдельным сообщением
        await vk.api.messages.send({
            peer_id: Number(peerId),
            random_id: Math.floor(Math.random() * 2000000000),
            message: message
        });
        
        console.log(`✅ Авто-отзыв для отчета ${reportId} отправлен`);
        
        // Помечаем как обработанный
        await db.ref(`reports/${reportId}`).update({
            autoReviewed: true,
            autoReviewTime: Date.now()
        });
        
    } catch (error) {
        console.error(`❌ Ошибка авто-оценки:`, error);
    }
});

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

// =======================
// ОБРАБОТКА КНОПОК
// =======================

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
        
        const newText = 
            `📝 ОТЧЕТ ${isApproved ? 'ОДОБРЕН' : 'ОТКЛОНЕН'}\n\n` +
            `👤 Ник: ${report.author || "—"}\n` +
            `🔰 Должность: ${report.role || "—"}\n` +
            `📅 Дата: ${report.date || "—"}\n\n` +
            `🛠 Работа: ${report.work || "—"}\n` +
            `⚖️ Наказания: ${report.punishments || "Нет"}\n` +
            `📊 Баллы: ${report.score || 0}\n\n` +
            `${statusIcon}\n👤 Проверил: ${adminName}`;

        try {
            // Получаем текущее сообщение для сохранения attachment
            const messages = await vk.api.messages.getByConversationMessageId({
                peer_id: ctx.peerId,
                conversation_message_ids: [ctx.conversationMessageId]
            });
            
            if (messages.items && messages.items[0]) {
                const currentMessage = messages.items[0];
                
                // СОБИРАЕМ ВСЕ ATTACHMENT
                const currentAttachments = currentMessage.attachments || [];
                const attachmentStrings = currentAttachments.map(att => {
                    if (att.type === 'photo' && att.photo) {
                        return `photo${att.photo.owner_id}_${att.photo.id}${att.photo.access_key ? `_${att.photo.access_key}` : ''}`;
                    }
                    return null;
                }).filter(Boolean);
                
                console.log(`📎 Найдено фотографий: ${attachmentStrings.length}`);
                
                // Редактируем с сохранением всех attachment
                await vk.api.messages.edit({
                    peer_id: ctx.peerId,
                    conversation_message_id: ctx.conversationMessageId,
                    message: newText,
                    attachment: attachmentStrings.join(','),
                    keyboard: Keyboard.builder().inline().toString()
                });
                
                console.log(`✅ Отчет ${reportId} обработан с сохранением ${attachmentStrings.length} фото`);
                
            } else {
                // Если не удалось получить сообщение, пробуем использовать сохраненные attachment
                if (report.vkAttachments) {
                    await vk.api.messages.edit({
                        peer_id: ctx.peerId,
                        conversation_message_id: ctx.conversationMessageId,
                        message: newText,
                        attachment: report.vkAttachments,
                        keyboard: Keyboard.builder().inline().toString()
                    });
                    console.log(`✅ Использованы сохраненные attachment для отчета ${reportId}`);
                } else {
                    await vk.api.messages.edit({
                        peer_id: ctx.peerId,
                        conversation_message_id: ctx.conversationMessageId,
                        message: newText,
                        keyboard: Keyboard.builder().inline().toString()
                    });
                    console.log(`⚠️ Отчет ${reportId} обработан без фото`);
                }
            }
            
        } catch (editError) {
            console.error("Ошибка при редактировании:", editError);
            
            await vk.api.messages.edit({
                peer_id: ctx.peerId,
                conversation_message_id: ctx.conversationMessageId,
                message: newText,
                keyboard: Keyboard.builder().inline().toString()
            });
        }

    } catch (e) { 
        console.error("Ошибка кнопок:", e); 
    }
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

async function initializeExistingData() {
    console.log("[INIT] Загружаю существующие данные...");
    
    const usersSnap = await db.ref("users").once("value");
    const users = usersSnap.val() || {};
    existingUsers = new Set(Object.keys(users));
    console.log(`[INIT] Загружено пользователей: ${existingUsers.size}`);
    
    const reportsSnap = await db.ref("reports").once("value");
    const reports = reportsSnap.val() || {};
    existingReports = new Set(Object.keys(reports));
    console.log(`[INIT] Загружено отчетов: ${existingReports.size}`);
    
    // Загружаем уже обработанные покупки
    const purchasesSnap = await db.ref("shop_purchases").once("value");
    const purchases = purchasesSnap.val() || {};
    Object.keys(purchases).forEach(id => processedPurchases.add(id));
    console.log(`[INIT] Загружено покупок: ${processedPurchases.size}`);
    
    // Загружаем уже обработанные отчеты для авто-оценки
    Object.entries(reports).forEach(([id, report]) => {
        if (report.autoReviewed) processedReportsForReview.add(id);
    });
    console.log(`[INIT] Загружено авто-оцененных отчетов: ${processedReportsForReview.size}`);
    
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
    
    if (existingUsers.has(userId)) {
        console.log(`[USER] Пользователь ${userId} уже существовал, пропускаем`);
        return;
    }
    
    existingUsers.add(userId);
    
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
});

// =======================
// ОБРАБОТКА НОВЫХ ОТЧЕТОВ (ИСПРАВЛЕНО - не кидает отдельные сообщения)
// =======================

db.ref("reports").on("child_added", async (snap) => {
    if (!isBotReady) return;
    
    const reportId = snap.key;
    const report = snap.val();
    
    if (existingReports.has(reportId)) {
        console.log(`[REPORT] Отчет ${reportId} уже существовал, пропускаем`);
        return;
    }
    
    existingReports.add(reportId);
    
    // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: проверяем, не это ли сообщение с фотографиями
    if (report.vkMessageId || report.botProcessed) {
        console.log(`[REPORT] Отчет ${reportId} уже был обработан`);
        return;
    }
    
    // Дополнительная проверка: если в отчете нет основных данных, это вероятно сообщение с фото
    if (!report.author && !report.work && !report.score) {
        console.log(`[REPORT] Пропускаем отчет ${reportId} - вероятно, это сообщение с фото`);
        return;
    }
    
    console.log(`[REPORT] Обрабатываю новый отчет ${reportId}`);
    await processNewReport(reportId, report);
});

async function processNewReport(reportId, report) {
    try {
        const peerId = await getChatId();
        if (!peerId) {
            console.error(`[REPORT] Нет peerId для отчета ${reportId}`);
            return;
        }

        // Проверяем, валидный ли это отчет
        if (!report.author || !report.date) {
            console.log(`[REPORT] Пропускаем некорректный отчет ${reportId}: отсутствуют обязательные поля`);
            return;
        }

        const text = 
            `📝 НОВЫЙ ОТЧЕТ\n\n` +
            `👤 Ник: ${report.author || "—"}\n` +
            `🔰 Должность: ${report.role || "—"}\n` +
            `📅 Дата: ${report.date || "—"}\n\n` +
            `🛠 Работа: ${report.work || "—"}\n` +
            `⚖️ Наказания: ${report.punishments || "Нет"}\n` +
            `📊 Баллы: ${report.score || 0}`;
        
        const attachments = [];
        
        // Обрабатываем фотографии ТОЛЬКО если их не больше 10
        if (report.imgs && Array.isArray(report.imgs)) {
            console.log(`[PHOTO] Найдено ${report.imgs.length} фото для отчета ${reportId}`);
            
            // Ограничиваем максимальное количество фото до 10
            const maxPhotos = Math.min(report.imgs.length, 10);
            
            for (let i = 0; i < maxPhotos; i++) {
                const imgData = report.imgs[i];
                
                if (typeof imgData === 'string' && imgData.startsWith('data:image')) {
                    try {
                        const base64Data = imgData.replace(/^data:image\/\w+;base64,/, '');
                        const buffer = Buffer.from(base64Data, 'base64');
                        
                        const mimeMatch = imgData.match(/^data:(image\/\w+);base64,/);
                        const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
                        
                        console.log(`[PHOTO ${i+1}/${maxPhotos}] Загружаю фото для отчета ${reportId}`);
                        
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
                        console.error(`[PHOTO ${i+1}/${maxPhotos}] Ошибка:`, error.message);
                    }
                }
                
                // Небольшая задержка между загрузками
                if (i < maxPhotos - 1) {
                    await new Promise(resolve => setTimeout(resolve, 300));
                }
            }
        }
        
        console.log(`[REPORT] Всего загружено фото для отчета ${reportId}: ${attachments.length}`);
        
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
        
        try {
            // Отправляем ВСЕ в одном сообщении: текст + фото + кнопки
            const msgId = await vk.api.messages.send({
                peer_id: Number(peerId),
                random_id: Math.floor(Math.random() * 2000000000),
                message: text,
                attachment: attachments.length > 0 ? attachments.join(',') : undefined,
                keyboard: keyboard
            });
            
            console.log(`✅ Отчет ${reportId} отправлен с ${attachments.length} фото в одном сообщении`);
            
            // Сохраняем информацию об отчете
            const attachmentString = attachments.length > 0 ? attachments.join(',') : '';
            
            await db.ref(`reports/${reportId}`).update({
                vkMessageId: msgId,
                vkText: text,
                vkAttachments: attachmentString,
                status: "pending",
                processedAt: Date.now(),
                botProcessed: true,
                photoCount: attachments.length
            });
            
        } catch (sendError) {
            console.error(`❌ Ошибка отправки отчета ${reportId}:`, sendError);
            
            // Если ошибка из-за attachment, пробуем отправить без фото
            if (sendError.code === 914 || sendError.message.includes('attachment')) {
                console.log(`[REPORT] Отправляю отчет ${reportId} без фото`);
                
                const msgId = await vk.api.messages.send({
                    peer_id: Number(peerId),
                    random_id: Math.floor(Math.random() * 2000000000),
                    message: text + '\n\n⚠️ Фотографии не загружены (превышен лимит)',
                    keyboard: keyboard
                });
                
                await db.ref(`reports/${reportId}`).update({
                    vkMessageId: msgId,
                    vkText: text,
                    status: "pending",
                    processedAt: Date.now(),
                    botProcessed: true,
                    photoCount: 0
                });
            }
        }
        
    } catch (error) {
        console.error(`❌ Общая ошибка отчета ${reportId}:`, error);
    }
}

// =======================
// ФИЛЬТРАЦИЯ ЛИШНИХ СООБЩЕНИЙ (ЗАЩИТА ОТ СПАМА)
// =======================

setInterval(async () => {
    if (!isBotReady) return;
    
    try {
        console.log(`[CLEANUP] Проверка на дубликаты отчетов...`);
        
        // Находим отчеты с одинаковыми данными
        const reportsSnap = await db.ref("reports").orderByChild("processedAt").once("value");
        const reports = reportsSnap.val() || {};
        
        const seenCombinations = new Map(); // Храним комбинации для обнаружения дубликатов
        const duplicates = [];
        
        for (const [reportId, report] of Object.entries(reports)) {
            if (report.author && report.date) {
                const key = `${report.author}_${report.date}_${report.work || ''}`;
                
                if (seenCombinations.has(key)) {
                    const originalId = seenCombinations.get(key);
                    
                    // Если этот отчет новее оригинального и имеет photoCount, это может быть дубликат с фото
                    if (report.photoCount > 0 && report.processedAt > reports[originalId].processedAt) {
                        duplicates.push({ duplicateId: reportId, originalId, key });
                    }
                } else {
                    seenCombinations.set(key, reportId);
                }
            }
        }
        
        if (duplicates.length > 0) {
            console.log(`[CLEANUP] Найдено ${duplicates.length} возможных дубликатов`);
            
            for (const dup of duplicates) {
                console.log(`[CLEANUP] Дубликат: ${dup.duplicateId} -> ${dup.originalId} (${dup.key})`);
                
                // Можно пометить дубликаты для игнорирования
                await db.ref(`reports/${dup.duplicateId}`).update({
                    isDuplicate: true,
                    duplicateOf: dup.originalId
                });
            }
        }
        
    } catch (error) {
        console.error(`[CLEANUP] Ошибка проверки:`, error);
    }
}, 10 * 60 * 1000); // Проверка каждые 10 минут

// Периодическая очистка множеств (чтобы не росло бесконечно)
setInterval(() => {
    const hourAgo = Date.now() - 3600000;
    
    // Очищаем processedPurchases
    for (const purchaseId of processedPurchases) {
        // В реальном коде здесь была бы проверка времени,
        // но т.к. у нас только Set, просто ограничим размер
        if (processedPurchases.size > 1000) {
            processedPurchases.delete(purchaseId);
        }
    }
    
    // Очищаем processedReportsForReview
    for (const reportId of processedReportsForReview) {
        if (processedReportsForReview.size > 1000) {
            processedReportsForReview.delete(reportId);
        }
    }
}, 3600000); // Каждый час

// =======================
// ЗАПУСК
// =======================

async function startBot() {
    try {
        await initializeExistingData();
        await vk.updates.start();
        
        console.log('🤖 Бот успешно запущен');
        console.log('📊 Команды: /bind, /id, /info [ник]');
        console.log('🛒 Уведомления о покупках: ВКЛЮЧЕНО');
        console.log('🧠 Авто-анализ отчетов: ВКЛЮЧЕНО');
        console.log('⚠️  Фото отправляются только в основном сообщении отчета');
        console.log('📸 Максимум 10 фото в одном сообщении');
        console.log('🛡  Защита от дублирования сообщений с фото');
        
    } catch (error) {
        console.error('❌ Ошибка запуска:', error);
    }
}

startBot();

// Веб-сервер для проверки
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`✅ Бот работает\n📊 Пользователей: ${existingUsers.size}\n📝 Отчетов: ${existingReports.size}\n🛒 Обработано покупок: ${processedPurchases.size}\n🧠 Авто-оценок: ${processedReportsForReview.size}`);
}).listen(process.env.PORT || 3000);

console.log(`🌐 Сервер на порту ${process.env.PORT || 3000}`);
