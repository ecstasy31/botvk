import { VK, Keyboard, MessageContext } from "vk-io";
import admin from "firebase-admin";
import fetch from "node-fetch";
import http from "http";
import fs from "fs";
import path from "path";

// =======================
// ИНИЦИАЛИЗАЦИЯ
// =======================
const vk = new VK({
    token: process.env.VK_TOKEN,
    apiVersion: "5.199",
    pollingGroupId: Number(process.env.VK_GROUP_ID)
});

// Укажи основной адрес сайта БЕЗ слеша в конце
const SITE_URL = "https://ecstasy31.github.io/moderation-panel/?clckid=dd788c52"; 

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
        databaseURL: "https://modersekb-default-rtdb.firebaseio.com"
    });
}

const db = admin.database();
let isBotReady = false; // Флаг для игнорирования старых отчетов при старте
let processedReports = new Set(); // Множество для отслеживания обработанных отчетов

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

    // КОМАНДА ДЛЯ ТАБЛИЦЫ - ПОКАЗЫВАЕТ ИНФОРМАЦИЮ ИЗ ТАБЛИЦЫ САЙТА
    if (text.toLowerCase().startsWith("/table") || text.toLowerCase().startsWith("/таблица")) {
        const nickRaw = text.replace(/^\/(table|таблица)\s*/i, "").trim();
        if (!nickRaw) {
            // Если ник не указан, показываем всю таблицу
            try {
                const tableSnap = await db.ref("full_table").once("value");
                const tableData = tableSnap.val() || {};
                
                if (Object.keys(tableData).length === 0) {
                    return ctx.send("📊 Таблица пока пуста.");
                }
                
                // Формируем список всех пользователей из таблицы
                let message = "📊 ОБЩАЯ ТАБЛИЦА МОДЕРАЦИИ:\n\n";
                
                Object.values(tableData).forEach((row, index) => {
                    const daysSinceStart = row.dateStart ? calculateDaysSince(row.dateStart) : "?";
                    const daysSincePromotion = row.lastUp && row.lastUp !== "-" ? calculateDaysSince(row.lastUp) : "-";
                    
                    message += `${index + 1}. ${row.nick || "Неизвестно"}\n`;
                    message += `   Должность: ${row.rank || "-"}\n`;
                    message += `   Начал: ${row.dateStart || "-"} (${daysSinceStart} дн.)\n`;
                    message += `   Выговоры: ${row.warns || "[0/3]"}\n`;
                    message += `   Предупреждения: ${row.preds || "[0/2]"}\n`;
                    message += `   Последнее повышение: ${row.lastUp || "-"}`;
                    if (daysSincePromotion !== "-") {
                        message += ` (${daysSincePromotion} дн.)`;
                    }
                    message += `\n${"-".repeat(30)}\n`;
                });
                
                return ctx.send(message);
                
            } catch (error) {
                console.error("Ошибка при получении таблицы:", error);
                return ctx.send("❌ Ошибка при получении данных таблицы.");
            }
        }
        
        // Если указан ник, ищем конкретного пользователя
        try {
            const tableSnap = await db.ref("full_table").once("value");
            const tableData = tableSnap.val() || {};
            
            // Ищем пользователя в таблице (регистронезависимый поиск)
            const userEntry = Object.values(tableData).find(row => 
                row.nick && row.nick.toLowerCase().includes(nickRaw.toLowerCase())
            );
            
            if (!userEntry) {
                return ctx.send(`❌ Пользователь "${nickRaw}" не найден в таблице.`);
            }
            
            const daysSinceStart = userEntry.dateStart ? calculateDaysSince(userEntry.dateStart) : "?";
            const daysSincePromotion = userEntry.lastUp && userEntry.lastUp !== "-" ? calculateDaysSince(userEntry.lastUp) : "-";
            
            // Формируем подробное сообщение
            let message = `📊 ИНФОРМАЦИЯ ИЗ ТАБЛИЦЫ:\n\n`;
            message += `👤 Ник: ${userEntry.nick || "-"}\n`;
            message += `🎖 Должность: ${userEntry.rank || "-"}\n`;
            message += `📅 Дата начала: ${userEntry.dateStart || "-"} (${daysSinceStart} дней назад)\n`;
            message += `⚠️ Выговоры: ${userEntry.warns || "[0/3]"}\n`;
            message += `📋 Предупреждения: ${userEntry.preds || "[0/2]"}\n`;
            message += `📈 Последнее повышение: ${userEntry.lastUp || "-"}`;
            if (daysSincePromotion !== "-") {
                message += ` (${daysSincePromotion} дней назад)`;
            }
            
            return ctx.send(message);
            
        } catch (error) {
            console.error("Ошибка при поиске в таблице:", error);
            return ctx.send("❌ Ошибка при получении данных из таблицы.");
        }
    }

    // СТАРАЯ КОМАНДА INFO (для обратной совместимости)
    if (text.toLowerCase().startsWith("/info")) {
        const nickRaw = text.replace(/^\/info\s*/i, "").trim();
        if (!nickRaw) return ctx.send("❗ Используй: /info Ник");

        const [usersSnap, reportsSnap, tableSnap] = await Promise.all([
            db.ref("users").once("value"),
            db.ref("reports").once("value"),
            db.ref("full_table").once("value")
        ]);

        const users = usersSnap.val() || {};
        const reports = reportsSnap.val() || {};
        const tableData = tableSnap.val() || {};
        
        const targetKey = Object.keys(users).find(k => k.toLowerCase() === nickRaw.toLowerCase());
        const userEntry = targetKey ? users[targetKey] : null;
        const userReports = Object.values(reports).filter(r => (r.author || "").toLowerCase() === nickRaw.toLowerCase());
        
        // Ищем в таблице
        const tableEntry = Object.values(tableData).find(row => 
            row.nick && row.nick.toLowerCase() === nickRaw.toLowerCase()
        );

        if (!userEntry && userReports.length === 0 && !tableEntry) {
            return ctx.send(`❌ Модератор "${nickRaw}" не найден.`);
        }

        const lastReport = userReports.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))[0];
        const avgScore = userReports.length ? Math.round(userReports.reduce((s, r) => s + (Number(r.score) || 0), 0) / userReports.length) : 0;
        
        // Дни из таблицы
        const daysSinceStart = tableEntry?.dateStart ? calculateDaysSince(tableEntry.dateStart) : "?";
        const daysSincePromotion = tableEntry?.lastUp && tableEntry.lastUp !== "-" ? calculateDaysSince(tableEntry.lastUp) : "-";

        // Ссылка на конкретного пользователя на сайте
        const personalUrl = `${SITE_URL}/#profile?user=${encodeURIComponent(targetKey || nickRaw)}`;

        let message = `📋 ИНФОРМАЦИЯ\n`;
        message += `👤 Ник: ${targetKey || nickRaw}\n`;
        message += `📧 Почта: ${userEntry?.email || "нет"}\n`;
        message += `🎖 Роль: ${userEntry?.role || lastReport?.role || "нет"}\n`;
        message += `🏢 Должность (таблица): ${tableEntry?.rank || userEntry?.rank || "нет"}\n`;
        message += `📅 Дата начала: ${tableEntry?.dateStart || "нет"}`;
        if (daysSinceStart !== "?") message += ` (${daysSinceStart} дн.)\n`;
        message += `⚠️ Выговоры: ${tableEntry?.warns || "[0/3]"}\n`;
        message += `📊 Баллы: ${userEntry?.score || 0}\n`;
        message += `📝 Отчетов: ${userReports.length}\n`;
        message += `📅 Последний отчет: ${lastReport?.date || "нет"}\n`;
        message += `📈 Средний балл: ${avgScore}`;
        if (tableEntry?.lastUp && tableEntry.lastUp !== "-") {
            message += `\n📈 Последнее повышение: ${tableEntry.lastUp}`;
            if (daysSincePromotion !== "-") message += ` (${daysSincePromotion} дн.)`;
        }

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

// Функция для расчета дней с даты
function calculateDaysSince(dateString) {
    if (!dateString || dateString === "-") return "?";
    
    try {
        const parts = dateString.split('.');
        if (parts.length !== 3) return "?";
        
        const day = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10) - 1;
        const year = parseInt(parts[2], 10);
        
        const date = new Date(year, month, day);
        if (isNaN(date.getTime())) return "?";
        
        const now = new Date();
        const diffTime = Math.abs(now - date);
        const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
        
        return diffDays.toString();
    } catch (error) {
        console.error("Ошибка при расчете дней:", error);
        return "?";
    }
}

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

// =======================
// НОВЫЕ ОТЧЕТЫ (ИСПРАВЛЕННАЯ ВЕРСИЯ)
// =======================

// При старте загружаем все существующие отчеты и добавляем их в processedReports
db.ref("reports").once("value", async (snap) => {
    const allReports = snap.val() || {};
    Object.keys(allReports).forEach(reportId => {
        processedReports.add(reportId);
    });
    
    isBotReady = true;
    console.log(`✅ База данных синхронизирована. Загружено ${processedReports.size} существующих отчетов. Бот готов принимать НОВЫЕ отчеты.`);
});

// Слушаем добавление новых отчетов
db.ref("reports").on("child_added", async (snap) => {
    const reportId = snap.key;
    const report = snap.val();
    
    // Проверяем, обрабатывали ли мы этот отчет ранее
    if (processedReports.has(reportId)) {
        console.log(`[SKIP] Отчет ${reportId} уже был обработан ранее. Пропускаем.`);
        return;
    }
    
    // Добавляем в обработанные
    processedReports.add(reportId);
    
    // Проверяем, готов ли бот
    if (!isBotReady) {
        console.log(`[WAIT] Бот еще не готов. Отложу отчет ${reportId}...`);
        setTimeout(() => {
            if (isBotReady) {
                processReport(reportId, report);
            }
        }, 5000);
        return;
    }
    
    await processReport(reportId, report);
});

// Функция обработки отчета
async function processReport(reportId, report) {
    try {
        // Проверяем, был ли отчет уже отправлен в ВК
        if (report.vkMessageId) {
            console.log(`[SKIP] Отчет ${reportId} уже отправлен в ВК. Пропускаем.`);
            return;
        }
        
        console.log(`[PROCESS] Обрабатываю новый отчет ${reportId} от ${report.author || "неизвестно"}`);
        
        // Пауза для стабилизации данных
        await new Promise(r => setTimeout(r, 1000));
        
        // Получаем свежие данные
        const freshSnap = await db.ref(`reports/${reportId}`).once("value");
        const freshReport = freshSnap.val();
        
        if (!freshReport) {
            console.error(`[ERROR] Отчет ${reportId} не найден в базе`);
            return;
        }
        
        // Получаем ID беседы
        const peerIdSnap = await db.ref("settings/chatPeerId").once("value");
        const peerId = peerIdSnap.val();
        
        if (!peerId) {
            console.error("⚠ ID беседы не установлен! Используйте /bind в нужной беседе.");
            return;
        }
        
        // Формируем текст сообщения
        const text = 
            `📝 НОВЫЙ ОТЧЕТ\n\n` +
            `👤 Ник: ${freshReport.author || "—"}\n` +
            `🔰 Должность: ${freshReport.role || "—"}\n` +
            `📅 Дата: ${freshReport.date || "—"}\n\n` +
            `🛠 Работа: ${freshReport.work || "—"}\n` +
            `⚖️ Наказания: ${freshReport.punishments || "Нет"}\n` +
            `📊 Баллы: ${freshReport.score || 0}`;
        
        // --- ЛОГИКА ЗАГРУЗКИ ФОТО ---
        const attachments = [];
        
        // Проверяем наличие изображений в формате base64
        if (freshReport.imgs && Array.isArray(freshReport.imgs)) {
            console.log(`[PHOTO] Найдено ${freshReport.imgs.length} фото для отчета ${reportId}`);
            
            for (let i = 0; i < freshReport.imgs.length; i++) {
                const imgData = freshReport.imgs[i];
                
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
            processedAt: Date.now()
        });
        
    } catch (error) {
        console.error(`❌ Критическая ошибка при обработке отчета ${reportId}:`, error);
        
        // Пытаемся отправить сообщение об ошибке (если возможно)
        try {
            const peerIdSnap = await db.ref("settings/chatPeerId").once("value");
            const peerId = peerIdSnap.val();
            
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
// ЗАПУСК
// =======================

vk.updates.start()
    .then(() => {
        console.log('🤖 Бот успешно запущен и мониторит ВК...');
        console.log('📊 Доступные команды:');
        console.log('  /bind - привязать текущую беседу');
        console.log('  /id - узнать ID беседы');
        console.log('  /info [ник] - информация о модераторе');
        console.log('  /table [ник] - информация из таблицы (или вся таблица)');
    })
    .catch(console.error);

// Веб-сервер для проверки работоспособности
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`Bot is running\nProcessed reports: ${processedReports.size}\nReady: ${isBotReady}`);
}).listen(process.env.PORT || 3000);

console.log(`🌐 Веб-сервер запущен на порту ${process.env.PORT || 3000}`);

