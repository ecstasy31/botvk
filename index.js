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

async function getUserInfo(userId) {
    try {
        const userSnap = await db.ref(`users/${userId}`).once("value");
        const userData = userSnap.val();
        
        if (!userData) return { username: userId, rank: "Не указано", score: 0 };
        
        return {
            username: userData.nick || userId,
            rank: userData.rank || "Не указано",
            score: userData.score || 0
        };
    } catch (error) {
        console.error(`[USER INFO] Ошибка получения данных пользователя ${userId}:`, error);
        return { username: userId, rank: "Не указано", score: 0 };
    }
}

async function getChatId() {
    const peerIdSnap = await db.ref("settings/chatPeerId").once("value");
    return peerIdSnap.val();
}

// =======================
// ИНИЦИАЛИЗАЦИЯ ДАННЫХ
// =======================

let existingUsers = new Set();
let existingReports = new Set();
let processedLogs = new Set();

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
    
    // Загружаем уже обработанные логи
    const logsSnap = await db.ref("logs").once("value");
    const logs = logsSnap.val() || {};
    processedLogs = new Set(Object.keys(logs));
    console.log(`[INIT] Загружено логов: ${processedLogs.size}`);
    
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
}

// =======================
// ОБРАБОТКА НОВЫХ ОТЧЕТОВ
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
    
    if (report.vkMessageId || report.botProcessed) {
        console.log(`[REPORT] Отчет ${reportId} уже был обработан`);
        return;
    }
    
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
        
        if (report.imgs && Array.isArray(report.imgs)) {
            console.log(`[PHOTO] Найдено ${report.imgs.length} фото для отчета ${reportId}`);
            
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
            const msgId = await vk.api.messages.send({
                peer_id: Number(peerId),
                random_id: Math.floor(Math.random() * 2000000000),
                message: text,
                attachment: attachments.length > 0 ? attachments.join(',') : undefined,
                keyboard: keyboard
            });
            
            console.log(`✅ Отчет ${reportId} отправлен с ${attachments.length} фото в одном сообщении`);
            
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
// ОБРАБОТКА ЛОГОВ ДЕЙСТВИЙ (ГЛАВНОЕ ИСПРАВЛЕНИЕ!)
// =======================

// Отслеживаем ВСЕ новые логи
db.ref("logs").on("child_added", async (snap) => {
    if (!isBotReady) return;
    
    const logId = snap.key;
    const log = snap.val();
    
    // Проверяем, не обрабатывался ли лог уже
    if (processedLogs.has(logId)) {
        console.log(`[LOG] Лог ${logId} уже был обработан`);
        return;
    }
    
    processedLogs.add(logId);
    
    // Помечаем лог как обработанный
    await db.ref(`logs/${logId}`).update({ vkProcessed: true });
    
    console.log(`[LOG] Обрабатываю новый лог: ${logId} - ${log.action || "без действия"}`);
    
    // Отправляем уведомление в зависимости от типа действия
    await processLogAction(logId, log);
});

async function processLogAction(logId, log) {
    try {
        const peerId = await getChatId();
        if (!peerId) {
            console.error(`[LOG] Нет peerId для лога ${logId}`);
            return;
        }

        // Пропускаем некоторые типы логов
        if (!log.action || !log.target || !log.by) {
            console.log(`[LOG] Пропускаем некорректный лог ${logId}`);
            return;
        }

        // Получаем информацию о пользователе
        const userInfo = await getUserInfo(log.target);
        
        let message = "";
        let icon = "📝";

        // Определяем тип действия и формируем сообщение
        if (log.action.includes("КУПИЛ В МАГАЗИНЕ:")) {
            icon = "🛒";
            const itemName = log.action.replace("КУПИЛ В МАГАЗИНЕ: ", "");
            
            message = `${icon} ПОКУПКА В МАГАЗИНЕ\n\n`;
            message += `👤 Покупатель: ${userInfo.username}\n`;
            message += `🏢 Должность: ${userInfo.rank}\n`;
            message += `📦 Товар: ${itemName}\n`;
            message += `💰 Текущий баланс: ${userInfo.score} баллов\n`;
            message += `🕒 Время: ${log.time || new Date().toLocaleString("ru-RU")}\n`;
            
        } else if (log.action.startsWith("РУЛЕТКА:")) {
            icon = "🎰";
            const resultText = log.action.replace("РУЛЕТКА: ", "");
            
            message = `${icon} РУЛЕТКА\n\n`;
            message += `👤 Игрок: ${userInfo.username}\n`;
            message += `🏢 Должность: ${userInfo.rank}\n`;
            message += `📊 Результат: ${resultText}\n`;
            
            // Пытаемся определить выигрыш
            if (resultText.includes("ВЫИГРЫШ:")) {
                icon = "🎉";
                message = message.replace("🎰", icon);
                
                if (resultText.includes("баллов")) {
                    // Извлекаем количество баллов
                    const match = resultText.match(/ВЫИГРЫШ:\s*(\d+)\s*баллов/);
                    if (match) {
                        const winAmount = parseInt(match[1]);
                        message += `💰 Выигрыш: ${winAmount} баллов\n`;
                    }
                } else {
                    const itemName = resultText.replace("ВЫИГРЫШ: ", "");
                    message += `🎁 Выигрыш: ${itemName}\n`;
                }
            } else if (resultText.includes("Увы, ничего") || resultText.includes("ничего не выпало")) {
                icon = "😔";
                message = message.replace("🎰", icon);
            }
            
            message += `💰 Текущий баланс: ${userInfo.score} баллов\n`;
            message += `🕒 Время: ${log.time || new Date().toLocaleString("ru-RU")}\n`;
            
        } else if (log.action.includes("Пропуск собрания")) {
            icon = "⏰";
            message = `${icon} ПРОПУСК СОБРАНИЯ\n\n`;
            message += `👤 Модератор: ${userInfo.username}\n`;
            message += `🏢 Должность: ${userInfo.rank}\n`;
            message += `💰 Списано: 5 баллов\n`;
            message += `💰 Текущий баланс: ${userInfo.score} баллов\n`;
            message += `🕒 Время: ${log.time || new Date().toLocaleString("ru-RU")}\n`;
            
        } else if (log.action.includes("Снял выговор себе") || log.action.includes("Снял выговор (админ)")) {
            icon = "✅";
            message = `${icon} СНЯТИЕ ВЫГОВОРА\n\n`;
            message += `👤 Модератор: ${userInfo.username}\n`;
            message += `🏢 Должность: ${userInfo.rank}\n`;
            
            if (log.action.includes("Снял выговор себе")) {
                message += `💰 Списано: 10 баллов\n`;
            }
            
            message += `💰 Текущий баланс: ${userInfo.score} баллов\n`;
            message += `🕒 Время: ${log.time || new Date().toLocaleString("ru-RU")}\n`;
            
        } else if (log.action.includes("Взял неактив")) {
            icon = "⏸️";
            // Извлекаем количество дней
            const daysMatch = log.action.match(/на (\d+) дн/);
            const days = daysMatch ? daysMatch[1] : "?";
            
            message = `${icon} ВЗЯТИЕ НЕАКТИВА\n\n`;
            message += `👤 Модератор: ${userInfo.username}\n`;
            message += `🏢 Должность: ${userInfo.rank}\n`;
            message += `📅 Срок: ${days} дней\n`;
            message += `💰 Списано: 10 баллов\n`;
            message += `💰 Текущий баланс: ${userInfo.score} баллов\n`;
            message += `🕒 Время: ${log.time || new Date().toLocaleString("ru-RU")}\n`;
            
        } else if (log.action.includes("Вышел из неактива")) {
            icon = "▶️";
            message = `${icon} ВЫХОД ИЗ НЕАКТИВА\n\n`;
            message += `👤 Модератор: ${userInfo.username}\n`;
            message += `🏢 Должность: ${userInfo.rank}\n`;
            message += `💰 Текущий баланс: ${userInfo.score} баллов\n`;
            message += `🕒 Время: ${log.time || new Date().toLocaleString("ru-RU")}\n`;
            
        } else if (log.action.includes("Сменил ник")) {
            icon = "📛";
            const newName = log.action.replace("Сменил ник на ", "");
            
            message = `${icon} СМЕНА НИКА\n\n`;
            message += `👤 Модератор: ${userInfo.username}\n`;
            message += `🏢 Должность: ${userInfo.rank}\n`;
            message += `📛 Новый ник: ${newName}\n`;
            message += `🕒 Время: ${log.time || new Date().toLocaleString("ru-RU")}\n`;
            
        } else if (log.action.includes("Подтвердил почту")) {
            icon = "📧";
            message = `${icon} ПОДТВЕРЖДЕНИЕ ПОЧТЫ\n\n`;
            message += `👤 Пользователь: ${userInfo.username}\n`;
            message += `🏢 Должность: ${userInfo.rank}\n`;
            message += `✅ Почта подтверждена\n`;
            message += `🕒 Время: ${log.time || new Date().toLocaleString("ru-RU")}\n`;
            
        } else if (log.action.includes("Выдал выговор")) {
            icon = "⚠️";
            message = `${icon} ВЫГОВОР ВЫДАН\n\n`;
            message += `👤 Модератор: ${userInfo.username}\n`;
            message += `🏢 Должность: ${userInfo.rank}\n`;
            message += `👮‍♂️ Кем выдан: ${log.by}\n`;
            message += `🕒 Время: ${log.time || new Date().toLocaleString("ru-RU")}\n`;
            
        } else if (log.action.includes("Отправил отчет")) {
            icon = "📝";
            message = `${icon} НОВЫЙ ОТЧЕТ\n\n`;
            message += `👤 Автор: ${userInfo.username}\n`;
            message += `🏢 Должность: ${userInfo.rank}\n`;
            message += `🕒 Время: ${log.time || new Date().toLocaleString("ru-RU")}\n`;
            message += `\nℹ️ Отчет отправлен на проверку`;
            
        } else if (log.action.includes("Одобрил заявку") || log.action.includes("Выдал Админку") || 
                   log.action.includes("Снял Админку") || log.action.includes("Кикнул")) {
            icon = "👮‍♂️";
            message = `${icon} АДМИН ДЕЙСТВИЕ\n\n`;
            message += `👤 Цель: ${userInfo.username}\n`;
            message += `🏢 Должность: ${userInfo.rank}\n`;
            message += `🔧 Действие: ${log.action}\n`;
            message += `👮‍♂️ Админ: ${log.by}\n`;
            message += `🕒 Время: ${log.time || new Date().toLocaleString("ru-RU")}\n`;
            
        } else {
            // Для всех остальных действий
            message = `${icon} СИСТЕМНОЕ ДЕЙСТВИЕ\n\n`;
            message += `👤 Пользователь: ${userInfo.username}\n`;
            message += `🏢 Должность: ${userInfo.rank}\n`;
            message += `🔧 Действие: ${log.action}\n`;
            message += `👮‍♂️ Инициатор: ${log.by}\n`;
            message += `🕒 Время: ${log.time || new Date().toLocaleString("ru-RU")}\n`;
        }

        // Добавляем ссылку на профиль
        message += `\n━━━━━━━━━━━━━━━━━━━\n`;
        message += `🔗 Профиль: @ash_ecstasy ${SITE_URL}/#profile?user=${encodeURIComponent(log.target)}`;

        // Отправляем сообщение
        await vk.api.messages.send({
            peer_id: Number(peerId),
            random_id: Math.floor(Math.random() * 2000000000),
            message: message
        });
        
        console.log(`✅ Уведомление о действии "${log.action}" отправлено`);
        
    } catch (error) {
        console.error(`❌ Ошибка при обработке лога ${logId}:`, error);
    }
}

// =======================
// ДОПОЛНИТЕЛЬНАЯ ПРОВЕРКА И ОБРАБОТКА СТАРЫХ ЛОГОВ
// =======================

// Функция для периодической проверки непрочитанных логов
async function checkUnprocessedLogs() {
    if (!isBotReady) return;
    
    try {
        console.log(`[LOG CHECK] Проверяю непрочитанные логи...`);
        
        const logsSnap = await db.ref("logs").once("value");
        const logs = logsSnap.val() || {};
        
        let unprocessedCount = 0;
        
        for (const [logId, log] of Object.entries(logs)) {
            // Пропускаем уже обработанные
            if (processedLogs.has(logId)) continue;
            if (log.vkProcessed) {
                processedLogs.add(logId);
                continue;
            }
            
            unprocessedCount++;
            
            // Добавляем в обработанные и обрабатываем
            processedLogs.add(logId);
            await db.ref(`logs/${logId}`).update({ vkProcessed: true });
            
            // Даем небольшую задержку между обработкой старых логов
            await new Promise(resolve => setTimeout(resolve, 500));
            
            console.log(`[LOG CHECK] Обрабатываю старый лог: ${logId} - ${log.action || "без действия"}`);
            await processLogAction(logId, log);
        }
        
        if (unprocessedCount > 0) {
            console.log(`[LOG CHECK] Обработано ${unprocessedCount} непрочитанных логов`);
        }
        
    } catch (error) {
        console.error(`[LOG CHECK] Ошибка проверки логов:`, error);
    }
}

// Запускаем проверку каждые 5 минут
setInterval(checkUnprocessedLogs, 5 * 60 * 1000);

// =======================
// ФИЛЬТРАЦИЯ ЛИШНИХ СООБЩЕНИЙ
// =======================

setInterval(async () => {
    if (!isBotReady) return;
    
    try {
        console.log(`[CLEANUP] Проверка на дубликаты отчетов...`);
        
        const reportsSnap = await db.ref("reports").orderByChild("processedAt").once("value");
        const reports = reportsSnap.val() || {};
        
        const seenCombinations = new Map();
        const duplicates = [];
        
        for (const [reportId, report] of Object.entries(reports)) {
            if (report.author && report.date) {
                const key = `${report.author}_${report.date}_${report.work || ''}`;
                
                if (seenCombinations.has(key)) {
                    const originalId = seenCombinations.get(key);
                    
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
                
                await db.ref(`reports/${dup.duplicateId}`).update({
                    isDuplicate: true,
                    duplicateOf: dup.originalId
                });
            }
        }
        
    } catch (error) {
        console.error(`[CLEANUP] Ошибка проверки:`, error);
    }
}, 10 * 60 * 1000);

// =======================
// ЗАПУСК
// =======================

async function startBot() {
    try {
        await initializeExistingData();
        await vk.updates.start();
        
        // Запускаем первоначальную проверку логов через 10 секунд после старта
        setTimeout(checkUnprocessedLogs, 10000);
        
        console.log('🤖 Бот успешно запущен');
        console.log('📊 Команды: /bind, /id, /info [ник]');
        console.log('🛒 Отслеживание покупок в магазине');
        console.log('🎰 Отслеживание рулетки');
        console.log('📝 Отслеживание всех действий пользователей');
        console.log('📸 Максимум 10 фото в одном сообщении');
        console.log('🛡  Защита от дублирования сообщений');
        
    } catch (error) {
        console.error('❌ Ошибка запуска:', error);
    }
}

startBot();

// Веб-сервер для проверки
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`✅ Бот работает\n📊 Пользователей: ${existingUsers.size}\n📝 Отчетов: ${existingReports.size}\n📜 Обработано логов: ${processedLogs.size}\n🛒 Отслеживает покупки\n🎰 Отслеживает рулетку`);
}).listen(process.env.PORT || 3000);

console.log(`🌐 Сервер на порту ${process.env.PORT || 3000}`);

