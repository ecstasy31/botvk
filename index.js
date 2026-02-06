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

const SITE_URL = "https://ecstasy31.github.io/moderation-panel/";

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
// ОБРАБОТКА КНОПОК (ИСПРАВЛЕНО - фотографии сохраняются)
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
        
        // СОЗДАЕМ НОВЫЙ ТЕКСТ С УЧЕТОМ СТАТУСА
        const newText = 
            `📝 ОТЧЕТ ${isApproved ? 'ОДОБРЕН' : 'ОТКЛОНЕН'}\n\n` +
            `👤 Ник: ${report.author || "—"}\n` +
            `🔰 Должность: ${report.role || "—"}\n` +
            `📅 Дата: ${report.date || "—"}\n\n` +
            `🛠 Работа: ${report.work || "—"}\n` +
            `⚖️ Наказания: ${report.punishments || "Нет"}\n` +
            `📊 Баллы: ${report.score || 0}\n\n` +
            `${statusIcon}\n👤 Проверил: ${adminName}`;

        // КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ: получаем текущее сообщение, чтобы сохранить attachment
        try {
            // Получаем информацию о текущем сообщении
            const messages = await vk.api.messages.getByConversationMessageId({
                peer_id: ctx.peerId,
                conversation_message_ids: [ctx.conversationMessageId]
            });
            
            if (messages.items && messages.items[0]) {
                const currentMessage = messages.items[0];
                
                // Сохраняем текущие attachment (фотографии)
                const currentAttachments = currentMessage.attachments || [];
                const attachmentStrings = currentAttachments.map(att => {
                    // Формируем строку attachment в формате VK API
                    return `${att.type}${att[att.type] ? `${att[att.type].owner_id}_${att[att.type].id}` : ''}`;
                }).filter(Boolean);
                
                console.log(`📎 Найдено attachment: ${attachmentStrings.length}`);
                
                // РЕДАКТИРУЕМ СООБЩЕНИЕ С СОХРАНЕНИЕМ ATTACHMENT
                await vk.api.messages.edit({
                    peer_id: ctx.peerId,
                    conversation_message_id: ctx.conversationMessageId,
                    message: newText,
                    attachment: attachmentStrings.join(','), // СОХРАНЯЕМ ФОТОГРАФИИ
                    keyboard: Keyboard.builder().inline().toString() // Убираем кнопки
                });
                
                console.log(`✅ Отчет ${reportId} обработан с сохранением фотографий`);
            } else {
                // Если не удалось получить текущее сообщение, редактируем без attachment
                await vk.api.messages.edit({
                    peer_id: ctx.peerId,
                    conversation_message_id: ctx.conversationMessageId,
                    message: newText,
                    keyboard: Keyboard.builder().inline().toString()
                });
                
                console.log(`⚠️ Отчет ${reportId} обработан, но фотографии могут быть утеряны`);
            }
            
        } catch (editError) {
            console.error("Ошибка при получении/редактировании сообщения:", editError);
            
            // Альтернативный способ: попробуем заново загрузить фотографии
            const peerId = await getChatId();
            if (peerId && report.imgs && Array.isArray(report.imgs) && report.imgs.length > 0) {
                try {
                    console.log(`🔄 Пробуем заново загрузить фотографии для отчета ${reportId}`);
                    
                    const attachments = [];
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
                                        filename: `report_${reportId}_edited_${i}.${mimeType.split('/')[1]}`
                                    },
                                    peer_id: Number(peerId)
                                });
                                
                                attachments.push(photo.toString());
                                
                            } catch (uploadError) {
                                console.error(`Ошибка загрузки фото ${i+1}:`, uploadError.message);
                            }
                        }
                    }
                    
                    // Редактируем с загруженными фотографиями
                    await vk.api.messages.edit({
                        peer_id: ctx.peerId,
                        conversation_message_id: ctx.conversationMessageId,
                        message: newText,
                        attachment: attachments.join(','),
                        keyboard: Keyboard.builder().inline().toString()
                    });
                    
                    console.log(`✅ Фотографии перезагружены для отчета ${reportId}`);
                    
                } catch (reuploadError) {
                    console.error("Ошибка при перезагрузке фотографий:", reuploadError);
                    
                    // Если все не удалось, просто редактируем текст
                    await vk.api.messages.edit({
                        peer_id: ctx.peerId,
                        conversation_message_id: ctx.conversationMessageId,
                        message: newText,
                        keyboard: Keyboard.builder().inline().toString()
                    });
                }
            } else {
                // Просто редактируем текст без фотографий
                await vk.api.messages.edit({
                    peer_id: ctx.peerId,
                    conversation_message_id: ctx.conversationMessageId,
                    message: newText,
                    keyboard: Keyboard.builder().inline().toString()
                });
            }
        }

    } catch (e) { 
        console.error("Ошибка кнопок:", e); 
        
        // Запасной вариант: отправляем новое сообщение с результатом
        try {
            const payload = ctx.eventPayload;
            if (!payload || !payload.reportId) return;
            
            const { reportId, action } = payload;
            const reportRef = db.ref(`reports/${reportId}`);
            const snap = await reportRef.once("value");
            const report = snap.val();
            
            if (!report) return;
            
            const [adminUser] = await vk.api.users.get({ user_ids: ctx.userId });
            const adminName = `${adminUser.first_name} ${adminUser.last_name}`;
            const isApproved = action === "ok";
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
            
            // Пробуем заново загрузить фотографии для нового сообщения
            const peerId = await getChatId();
            const attachments = [];
            
            if (peerId && report.imgs && Array.isArray(report.imgs)) {
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
                                    filename: `report_${reportId}_backup_${i}.${mimeType.split('/')[1]}`
                                },
                                peer_id: Number(peerId)
                            });
                            
                            attachments.push(photo.toString());
                            
                        } catch (uploadError) {
                            console.error(`Ошибка загрузки фото ${i+1}:`, uploadError.message);
                        }
                    }
                }
            }
            
            // Отправляем новое сообщение как запасной вариант
            await vk.api.messages.send({
                peer_id: ctx.peerId,
                random_id: Math.floor(Math.random() * 2000000000),
                message: newText,
                attachment: attachments.join(',')
            });
            
            console.log(`⚠️ Отчет ${reportId} отправлен новым сообщением`);
            
        } catch (sendError) {
            console.error("Не удалось отправить сообщение об ошибке:", sendError);
        }
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

let existingUsers = new Set();
let existingReports = new Set();

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
                } else if (typeof imgData === 'string' && (imgData.startsWith('http://') || imgData.startsWith('https://'))) {
                    const uploaded = await uploadImageToVK(imgData, peerId);
                    if (uploaded) attachments.push(uploaded);
                }
            }
        }
        
        // Сохраняем attachment ID для последующего использования
        const attachmentIds = attachments.join(',');
        
        const keyboard = Keyboard.builder()
            .inline()
            .callbackButton({ 
                label: "✅ Одобрить", 
                payload: { reportId, action: "ok", attachments: attachmentIds }, 
                color: "positive" 
            })
            .callbackButton({ 
                label: "❌ Отказать", 
                payload: { reportId, action: "no", attachments: attachmentIds }, 
                color: "negative" 
            })
            .toString();
        
        const msgId = await vk.api.messages.send({
            peer_id: Number(peerId),
            random_id: Math.floor(Math.random() * 2000000000),
            message: text,
            attachment: attachmentIds,
            keyboard: keyboard
        });
        
        console.log(`✅ Отчет ${reportId} отправлен с ${attachments.length} фото`);
        
        await db.ref(`reports/${reportId}`).update({
            vkMessageId: msgId,
            vkText: text,
            vkAttachments: attachmentIds, // Сохраняем ID attachment
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
        await initializeExistingData();
        await vk.updates.start();
        
        console.log('🤖 Бот успешно запущен');
        console.log('📊 Команды: /bind, /id, /info [ник]');
        console.log('📸 Фотографии сохраняются при одобрении/отклонении');
        
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

