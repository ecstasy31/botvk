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

// Укажи основной адрес сайта БЕЗ слеша в конце
const SITE_URL = "https://ваш-сайт.com"; 

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
        databaseURL: "https://modersekb-default-rtdb.firebaseio.com"
    });
}

const db = admin.database();
let isBotReady = false;
let botStartTime = null; // Время запуска бота
let processedUsers = new Set(); // Множество для отслеживания обработанных пользователей

console.log("🚀 Бот запускается...");

// =======================
// КОМАНДЫ (BIND, ID, INFO)
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

    // КОМАНДА INFO
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

        // Ссылка на конкретного пользователя на сайте
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

// Функция для загрузки изображения в ВК
async function uploadImageToVK(imageUrl, peerId) {
    try {
        console.log(`[UPLOAD] Начинаю загрузку изображения: ${imageUrl}`);
        
        // Скачиваем изображение
        const response = await fetch(imageUrl);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        // Получаем данные изображения
        const buffer = await response.buffer();
        
        // Определяем MIME тип
        let mimeType = 'image/jpeg';
        if (imageUrl.toLowerCase().endsWith('.png')) {
            mimeType = 'image/png';
        } else if (imageUrl.toLowerCase().endsWith('.gif')) {
            mimeType = 'image/gif';
        } else if (imageUrl.toLowerCase().endsWith('.webp')) {
            mimeType = 'image/webp';
        }
        
        // Загружаем в ВК
        const photo = await vk.upload.messagePhoto({
            source: {
                value: buffer,
                contentType: mimeType,
                filename: `photo_${Date.now()}.${mimeType.split('/')[1]}`
            },
            peer_id: Number(peerId)
        });
        
        console.log(`[UPLOAD] Изображение успешно загружено: ${photo.toString()}`);
        return photo.toString();
        
    } catch (error) {
        console.error(`[UPLOAD] Ошибка загрузки изображения ${imageUrl}:`, error.message);
        return null;
    }
}

// Получение ID беседы
async function getChatId() {
    const peerIdSnap = await db.ref("settings/chatPeerId").once("value");
    return peerIdSnap.val();
}

// =======================
// НОВЫЕ ПОЛЬЗОВАТЕЛИ
// =======================

// Обработка новых пользователей
db.ref("users").on("child_added", async (snap) => {
    const userId = snap.key;
    const userData = snap.val();
    
    // Проверяем, обрабатывали ли мы этого пользователя ранее
    if (processedUsers.has(userId)) {
        console.log(`[USER] Пользователь ${userId} уже был обработан ранее. Пропускаем.`);
        return;
    }
    
    // Добавляем в обработанные
    processedUsers.add(userId);
    
    // Проверяем, готов ли бот
    if (!isBotReady) {
        console.log(`[USER] Бот еще не готов. Отложу пользователя ${userId}...`);
        setTimeout(async () => {
            if (isBotReady) {
                await processNewUser(userId, userData);
            }
        }, 3000);
        return;
    }
    
    await processNewUser(userId, userData);
});

// Функция обработки нового пользователя
async function processNewUser(userId, userData) {
    try {
        // Проверяем, был ли пользователь уже уведомлен
        if (userData.vkNotified) {
            console.log(`[USER] Пользователь ${userId} уже был уведомлен. Пропускаем.`);
            return;
        }
        
        console.log(`[USER] Обрабатываю нового пользователя: ${userId}`);
        
        // Получаем ID беседы
        const peerId = await getChatId();
        if (!peerId) {
            console.error("[USER] ID беседы не установлен!");
            return;
        }
        
        // Формируем сообщение в зависимости от роли
        let message = "";
        if (userData.role === 'pending') {
            message = `🆕 НОВАЯ ЗАЯВКА НА ВСТУПЛЕНИЕ\n\n` +
                     `👤 Ник: ${userData.nick || userId}\n` +
                     `📧 Почта: ${userData.email || "не указана"}\n` +
                     `🕒 Время регистрации: ${new Date(userData.lastSeen || Date.now()).toLocaleString()}\n` +
                     `\n✍️ Требуется одобрение Главного Модератора\n` +
                     `Ссылка: ${SITE_URL}/#profile?user=${encodeURIComponent(userId)}`;
        } else {
            message = `👤 НОВЫЙ ПОЛЬЗОВАТЕЛЬ В СИСТЕМЕ\n\n` +
                     `Ник: ${userData.nick || userId}\n` +
                     `Роль: ${userData.role || "user"}\n` +
                     `Должность: ${userData.rank || "Не назначена"}\n` +
                     `\nДобро пожаловать в команду! 🎉`;
        }
        
        // Отправляем сообщение
        await vk.api.messages.send({
            peer_id: Number(peerId),
            random_id: Math.floor(Math.random() * 2000000000),
            message: message
        });
        
        console.log(`✅ Уведомление о новом пользователе ${userId} отправлено.`);
        
        // Помечаем как уведомленного
        await db.ref(`users/${userId}`).update({
            vkNotified: true,
            vkNotificationTime: Date.now()
        });
        
    } catch (error) {
        console.error(`❌ Ошибка при обработке нового пользователя ${userId}:`, error);
    }
}

// =======================
// НОВЫЕ ОТЧЕТЫ (ИСПРАВЛЕННЫЙ БАГ)
// =======================

// При старте бота запоминаем время запуска
db.ref("reports").once("value", async (snap) => {
    botStartTime = Date.now(); // Запоминаем время запуска бота
    isBotReady = true;
    console.log(`✅ Бот готов к работе. Запущен в: ${new Date(botStartTime).toLocaleString()}`);
    console.log(`📊 Будут обрабатываться только отчеты, созданные после запуска бота.`);
});

// Слушаем добавление новых отчетов
db.ref("reports").on("child_added", async (snap) => {
    if (!isBotReady) {
        console.log(`[REPORT] Бот еще не готов. Ждем...`);
        setTimeout(() => {
            if (isBotReady) {
                processNewReport(snap);
            }
        }, 3000);
        return;
    }
    
    await processNewReport(snap);
});

// Функция обработки нового отчета
async function processNewReport(snap) {
    const reportId = snap.key;
    const report = snap.val();
    
    try {
        // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Проверяем время создания отчета
        // Если отчет был создан ДО запуска бота - пропускаем его
        const reportCreationTime = report.timestamp || report.createdAt || 0;
        
        // Если отчет не имеет временной метки или был создан до запуска бота
        if (reportCreationTime && reportCreationTime < botStartTime) {
            console.log(`[SKIP] Отчет ${reportId} был создан ДО запуска бота (${new Date(reportCreationTime).toLocaleString()}). Пропускаем.`);
            return;
        }
        
        // Также проверяем, был ли отчет уже отправлен в ВК
        if (report.vkMessageId) {
            console.log(`[SKIP] Отчет ${reportId} уже отправлен в ВК. Пропускаем.`);
            return;
        }
        
        console.log(`[REPORT] Обрабатываю новый отчет ${reportId} от ${report.author || "неизвестно"}`);
        
        // Получаем ID беседы
        const peerId = await getChatId();
        if (!peerId) {
            console.error("[REPORT] ID беседы не установлен! Используйте /bind в нужной беседе.");
            return;
        }
        
        // Формируем текст сообщения
        const text = 
            `📝 НОВЫЙ ОТЧЕТ\n\n` +
            `👤 Ник: ${report.author || "—"}\n` +
            `🔰 Должность: ${report.role || "—"}\n` +
            `📅 Дата: ${report.date || "—"}\n\n` +
            `🛠 Работа: ${report.work || "—"}\n` +
            `⚖️ Наказания: ${report.punishments || "Нет"}\n` +
            `📊 Баллы: ${report.score || 0}`;
        
        // --- ЛОГИКА ЗАГРУЗКИ ФОТО ---
        const attachments = [];
        
        // Проверяем наличие изображений в формате base64
        if (report.imgs && Array.isArray(report.imgs)) {
            console.log(`[PHOTO] Найдено ${report.imgs.length} фото для отчета ${reportId}`);
            
            for (let i = 0; i < report.imgs.length; i++) {
                const imgData = report.imgs[i];
                
                // Проверяем, является ли это base64
                if (typeof imgData === 'string' && imgData.startsWith('data:image')) {
                    try {
                        // Преобразуем base64 в Buffer
                        const base64Data = imgData.replace(/^data:image\/\w+;base64,/, '');
                        const buffer = Buffer.from(base64Data, 'base64');
                        
                        // Определяем MIME тип
                        const mimeMatch = imgData.match(/^data:(image\/\w+);base64,/);
                        const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
                        
                        // Загружаем в ВК
                        const photo = await vk.upload.messagePhoto({
                            source: {
                                value: buffer,
                                contentType: mimeType,
                                filename: `report_${reportId}_${i}.${mimeType.split('/')[1]}`
                            },
                            peer_id: Number(peerId)
                        });
                        
                        attachments.push(photo.toString());
                        console.log(`[PHOTO] Фото ${i+1} успешно загружено`);
                        
                    } catch (error) {
                        console.error(`[PHOTO] Ошибка при загрузке base64 изображения ${i+1}:`, error.message);
                    }
                } else if (typeof imgData === 'string' && (imgData.startsWith('http://') || imgData.startsWith('https://'))) {
                    // Если это URL, скачиваем и загружаем
                    const uploaded = await uploadImageToVK(imgData, peerId);
                    if (uploaded) {
                        attachments.push(uploaded);
                    }
                }
            }
        }
        
        // Формируем клавиатуру с кнопками
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
        
        // Отправляем сообщение
        const msgId = await vk.api.messages.send({
            peer_id: Number(peerId),
            random_id: Math.floor(Math.random() * 2000000000),
            message: text,
            attachment: attachments.join(','),
            keyboard: keyboard
        });
        
        console.log(`✅ Отчет ${reportId} успешно отправлен в ВК (сообщение ID: ${msgId}) с ${attachments.length} фото.`);
        
        // Обновляем отчет в базе
        await db.ref(`reports/${reportId}`).update({
            vkMessageId: msgId,
            vkText: text,
            status: "pending",
            processedAt: Date.now(),
            botProcessed: true
        });
        
    } catch (error) {
        console.error(`❌ Ошибка при обработке отчета ${reportId}:`, error);
        
        // Пытаемся отправить сообщение об ошибке (если возможно)
        try {
            const peerId = await getChatId();
            
            if (peerId) {
                await vk.api.messages.send({
                    peer_id: Number(peerId),
                    random_id: Math.floor(Math.random() * 2000000000),
                    message: `⚠️ Ошибка при обработке отчета ${reportId}: ${error.message}\nПожалуйста, проверьте логи бота.`
                });
            }
        } catch (sendError) {
            console.error("Не удалось отправить сообщение об ошибке:", sendError);
        }
    }
}

// =======================
// ДОПОЛНИТЕЛЬНАЯ ФУНКЦИОНАЛЬНОСТЬ
// =======================

// Периодическая проверка необработанных отчетов (на всякий случай)
setInterval(async () => {
    if (!isBotReady) return;
    
    try {
        console.log(`[CHECK] Проверка на пропущенные отчеты...`);
        const peerId = await getChatId();
        if (!peerId) return;
        
        // Ищем отчеты без vkMessageId, созданные после запуска бота
        const reportsSnap = await db.ref("reports").once("value");
        const reports = reportsSnap.val() || {};
        
        let missedCount = 0;
        const now = Date.now();
        
        for (const [reportId, report] of Object.entries(reports)) {
            // Проверяем, что отчет:
            // 1. Не имеет vkMessageId (не отправлен)
            // 2. Был создан после запуска бота
            // 3. Не старше 1 часа (чтобы не обрабатывать очень старые)
            const reportTime = report.timestamp || report.createdAt || 0;
            
            if (!report.vkMessageId && 
                reportTime > botStartTime && 
                (now - reportTime) < 3600000) { // 1 час
                
                console.log(`[CHECK] Найден пропущенный отчет: ${reportId}`);
                missedCount++;
                
                // Обрабатываем отчет
                await processNewReport({ key: reportId, val: () => report });
            }
        }
        
        if (missedCount > 0) {
            console.log(`[CHECK] Найдено и обработано ${missedCount} пропущенных отчетов.`);
        }
        
    } catch (error) {
        console.error(`[CHECK] Ошибка при проверке отчетов:`, error);
    }
}, 300000); // Проверка каждые 5 минут

// =======================
// ЗАПУСК
// =======================

vk.updates.start()
    .then(() => {
        console.log('🤖 Бот успешно запущен и мониторит ВК...');
        console.log('📊 Доступные команды:');
        console.log('  /bind - привязать текущую беседу');
        console.log('  /id - узнать ID беседы');
        console.log('  /info [ник] - информация о модераторе');
        console.log('\n✅ Функционал:');
        console.log('  • Уведомления о новых пользователях');
        console.log('  • Отправка новых отчетов в чат');
        console.log('  • Кнопки для одобрения/отклонения отчетов');
        console.log('  • Загрузка фотографий как изображений');
        console.log(`\n🕒 Бот запущен: ${new Date().toLocaleString()}`);
    })
    .catch(console.error);

// Веб-сервер для проверки работоспособности
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`✅ Бот работает\n🕒 Запущен: ${new Date(botStartTime || Date.now()).toLocaleString()}\n📊 Обработано пользователей: ${processedUsers.size}\n🌐 Статус: ${isBotReady ? 'Готов' : 'Загрузка...'}`);
}).listen(process.env.PORT || 3000);

console.log(`🌐 Веб-сервер запущен на порту ${process.env.PORT || 3000}`);
