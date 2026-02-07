// =======================
// ПОЛНЫЙ КОД БОТА С ИСПРАВЛЕНИЯМИ
// =======================

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
let processedPurchases = new Set();
let processedRoulette = new Set();
let processedReports = new Set();

console.log("🚀 Бот запускается...");

// =======================
// ИНИЦИАЛИЗАЦИЯ ДАННЫХ
// =======================

async function initializeExistingData() {
    console.log("[INIT] Загружаю существующие данные...");
    
    // Пользователи
    const usersSnap = await db.ref("users").once("value");
    const users = usersSnap.val() || {};
    const existingUsers = new Set(Object.keys(users));
    console.log(`[INIT] Загружено пользователей: ${existingUsers.size}`);
    
    // Отчеты
    const reportsSnap = await db.ref("reports").once("value");
    const reports = reportsSnap.val() || {};
    Object.keys(reports).forEach(id => {
        if (reports[id].botProcessed) processedReports.add(id);
    });
    console.log(`[INIT] Загружено отчетов: ${Object.keys(reports).length}`);
    
    // Покупки
    const purchasesSnap = await db.ref("shop_purchases").once("value");
    const purchases = purchasesSnap.val() || {};
    Object.keys(purchases).forEach(id => {
        if (purchases[id].vkNotified) processedPurchases.add(id);
    });
    console.log(`[INIT] Загружено покупок: ${Object.keys(purchases).length}`);
    
    // Рулетка
    const rouletteSnap = await db.ref("roulette_spins").once("value");
    const roulette = rouletteSnap.val() || {};
    Object.keys(roulette).forEach(id => {
        if (roulette[id].vkNotified) processedRoulette.add(id);
    });
    console.log(`[INIT] Загружено спинов рулетки: ${Object.keys(roulette).length}`);
    
    isBotReady = true;
    console.log("[INIT] Бот готов к работе!");
}

// =======================
// 1️⃣ УВЕДОМЛЕНИЕ О ПОКУПКЕ В МАГАЗИНЕ
// =======================

db.ref("shop_purchases").on("child_added", async (snap) => {
    if (!isBotReady) return;
    
    const purchaseId = snap.key;
    const purchase = snap.val();
    
    // Защита от дубликатов
    if (processedPurchases.has(purchaseId) || purchase.vkNotified) {
        console.log(`[SHOP] Покупка ${purchaseId} уже обработана, пропускаем`);
        return;
    }
    
    console.log(`[SHOP] Обрабатываю покупку: ${purchaseId}`);
    await processPurchase(purchaseId, purchase);
});

async function processPurchase(purchaseId, purchase) {
    try {
        const peerIdSnap = await db.ref("settings/chatPeerId").once("value");
        const peerId = peerIdSnap.val();
        
        if (!peerId) {
            console.error(`[SHOP] Беседа не привязана!`);
            return;
        }
        
        // Форматируем время
        const time = purchase.timestamp 
            ? new Date(purchase.timestamp).toLocaleString("ru-RU", {
                hour: "2-digit",
                minute: "2-digit",
                day: "2-digit",
                month: "2-digit",
                year: "numeric"
            })
            : new Date().toLocaleString("ru-RU");
        
        // Форматируем сообщение
        const message = 
            `🛒 ПОКУПКА В МАГАЗИНЕ\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `👤 Модератор: [id713635121|${purchase.user || "Неизвестно"}]\n` +
            `🎁 Товар: ${purchase.item || "Неизвестно"}\n` +
            `💰 Стоимость: ${purchase.price || 0} баллов\n` +
            `🕐 Время: ${time}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `✅ Покупка зафиксирована в системе`;
        
        await vk.api.messages.send({
            peer_id: Number(peerId),
            random_id: Math.floor(Math.random() * 2000000000),
            message: message
        });
        
        console.log(`✅ Уведомление о покупке ${purchaseId} отправлено`);
        
        await db.ref(`shop_purchases/${purchaseId}`).update({
            vkNotified: true,
            vkNotificationTime: Date.now()
        });
        
        processedPurchases.add(purchaseId);
        
    } catch (error) {
        console.error(`❌ Ошибка покупки ${purchaseId}:`, error);
    }
}

// =======================
// 2️⃣ УВЕДОМЛЕНИЕ О РУЛЕТКЕ
// =======================

db.ref("roulette_spins").on("child_added", async (snap) => {
    if (!isBotReady) return;
    
    const spinId = snap.key;
    const spin = snap.val();
    
    // Защита от дубликатов
    if (processedRoulette.has(spinId) || spin.vkNotified) {
        console.log(`[ROULETTE] Спин ${spinId} уже обработан, пропускаем`);
        return;
    }
    
    console.log(`[ROULETTE] Обрабатываю спин: ${spinId}`);
    await processRouletteSpin(spinId, spin);
});

async function processRouletteSpin(spinId, spin) {
    try {
        const peerIdSnap = await db.ref("settings/chatPeerId").once("value");
        const peerId = peerIdSnap.val();
        
        if (!peerId) {
            console.error(`[ROULETTE] Беседа не привязана!`);
            return;
        }
        
        // Форматируем время
        const time = spin.timestamp 
            ? new Date(spin.timestamp).toLocaleString("ru-RU", {
                hour: "2-digit",
                minute: "2-digit",
                day: "2-digit",
                month: "2-digit",
                year: "numeric"
            })
            : new Date().toLocaleString("ru-RU");
        
        // Определяем иконку результата
        let resultIcon = "🎰";
        if (spin.result && spin.result.includes("ВЫИГРЫШ")) resultIcon = "🎁";
        if (spin.result && spin.result.includes("НИЧЕГО")) resultIcon = "❌";
        
        // Форматируем сообщение
        const message = 
            `${resultIcon} РЕЗУЛЬТАТ РУЛЕТКИ\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `👤 Игрок: [id713635121|${spin.user || "Неизвестно"}]\n` +
            `🎯 Результат: ${spin.result || "Не определен"}\n` +
            `💰 Стоимость спина: ${spin.cost || 15} баллов\n` +
            `🕐 Время: ${time}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `🎉 Удачи в следующий раз!`;
        
        await vk.api.messages.send({
            peer_id: Number(peerId),
            random_id: Math.floor(Math.random() * 2000000000),
            message: message
        });
        
        console.log(`✅ Уведомление о рулетке ${spinId} отправлено`);
        
        await db.ref(`roulette_spins/${spinId}`).update({
            vkNotified: true,
            vkNotificationTime: Date.now()
        });
        
        processedRoulette.add(spinId);
        
    } catch (error) {
        console.error(`❌ Ошибка рулетки ${spinId}:`, error);
    }
}

// =======================
// 3️⃣ АВТО-ОЦЕНКА ОТЧЁТА (ВМЕСТЕ С СООБЩЕНИЕМ)
// =======================

function generateAutoReview(report) {
    const remarks = [];
    const recommendations = [];
    
    // Базовые метрики
    const textLength = report.work ? report.work.trim().length : 0;
    const photoCount = report.imgs && Array.isArray(report.imgs) ? report.imgs.length : 0;
    const score = Number(report.score) || 0;
    const punishments = Number(report.punishments) || 0;
    
    // Анализ текста
    if (textLength < 50) {
        remarks.push("📉 Слишком краткое описание работы");
        recommendations.push("Детально опишите проделанную работу");
    } else if (textLength < 100) {
        remarks.push("📝 Описание можно дополнить");
        recommendations.push("Добавьте больше деталей о работе");
    } else if (textLength > 500) {
        remarks.push("📋 Описание слишком объемное");
        recommendations.push("Сократите до ключевых моментов");
    }
    
    // Анализ фото
    if (photoCount === 0) {
        remarks.push("📸 Отсутствуют доказательства");
        recommendations.push("Прикрепите скриншоты нарушений");
    } else if (photoCount === 1) {
        remarks.push("📷 Мало доказательств");
        recommendations.push("Добавьте больше скриншотов");
    } else if (photoCount >= 3) {
        remarks.push("✅ Достаточно доказательств");
    }
    
    // Анализ наказаний и баллов
    if (punishments > 0 && score === 0) {
        remarks.push("⚠️ Наказания есть, но баллов нет");
        recommendations.push("Укажите баллы за наказания");
    }
    
    if (score > 8 && photoCount < 2) {
        remarks.push("🔍 Высокий балл при малом количестве доказательств");
        recommendations.push("Добавьте больше скриншотов для подтверждения");
    }
    
    if (punishments > 10 && photoCount < 3) {
        remarks.push("⚖️ Много наказаний, мало доказательств");
        recommendations.push("Увеличьте количество скриншотов");
    }
    
    // Качество работы
    if (textLength >= 100 && photoCount >= 2 && punishments > 0) {
        remarks.push("✅ Качественный отчет");
    }
    
    // Формируем отзыв
    let review = "🧠 АВТО-АНАЛИЗ ОТЧЁТА\n";
    review += "━━━━━━━━━━━━━━━━━━\n";
    review += `📊 Общая оценка: ${score} баллов\n`;
    review += `📝 Длина текста: ${textLength} символов\n`;
    review += `📎 Приложено фото: ${photoCount} шт.\n`;
    review += `⚖️ Наказаний: ${punishments}\n\n`;
    
    if (remarks.length > 0) {
        review += "⚠️ Замечания:\n";
        remarks.forEach(r => review += `• ${r}\n`);
        review += "\n💡 Рекомендации:\n";
        recommendations.forEach(r => review += `• ${r}\n`);
    } else {
        review += "✅ Отчёт соответствует всем стандартам качества!\n";
        review += "📋 Полное описание работы\n";
        review += "📎 Достаточно доказательств\n";
        review += "⚖️ Адекватные наказания";
    }
    
    review += "\n━━━━━━━━━━━━━━━━━━\n";
    review += "ℹ️ Это автоматический анализ. Финальное решение - за проверяющим.";
    
    return review;
}

// =======================
// ОБРАБОТКА ОТЧЕТОВ С АВТО-ОЦЕНКОЙ
// =======================

db.ref("reports").on("child_added", async (snap) => {
    if (!isBotReady) return;
    
    const reportId = snap.key;
    const report = snap.val();
    
    // Защита от дубликатов
    if (processedReports.has(reportId) || report.botProcessed) {
        console.log(`[REPORT] Отчет ${reportId} уже обработан, пропускаем`);
        return;
    }
    
    // Пропускаем если нет основных данных
    if (!report.author || !report.work) {
        console.log(`[REPORT] Пропускаем некорректный отчет ${reportId}`);
        return;
    }
    
    console.log(`[REPORT] Обрабатываю отчет ${reportId} с авто-оценкой`);
    await processReportWithReview(reportId, report);
});

async function processReportWithReview(reportId, report) {
    try {
        const peerIdSnap = await db.ref("settings/chatPeerId").once("value");
        const peerId = peerIdSnap.val();
        
        if (!peerId) {
            console.error(`[REPORT] Беседа не привязана!`);
            return;
        }
        
        // Генерируем авто-оценку
        const autoReview = generateAutoReview(report);
        
        // Основное сообщение отчета
        const reportText = 
            `📝 НОВЫЙ ОТЧЕТ\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `👤 Ник: ${report.author || "—"}\n` +
            `🔰 Должность: ${report.role || "—"}\n` +
            `📅 Дата: ${report.date || "—"}\n\n` +
            `🛠 Работа: ${report.work || "—"}\n` +
            `⚖️ Наказания: ${report.punishments || "Нет"}\n` +
            `📊 Баллы: ${report.score || 0}\n\n` +
            `${autoReview}`;
        
        // Обрабатываем фото
        const attachments = [];
        if (report.imgs && Array.isArray(report.imgs)) {
            const maxPhotos = Math.min(report.imgs.length, 10);
            
            for (let i = 0; i < maxPhotos; i++) {
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
                        
                        await new Promise(resolve => setTimeout(resolve, 300));
                        
                    } catch (error) {
                        console.error(`[PHOTO ${i+1}] Ошибка:`, error.message);
                    }
                }
            }
        }
        
        // Клавиатура
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
            message: reportText,
            attachment: attachments.length > 0 ? attachments.join(',') : undefined,
            keyboard: keyboard
        });
        
        console.log(`✅ Отчет ${reportId} отправлен с авто-оценкой`);
        
        // Сохраняем данные
        await db.ref(`reports/${reportId}`).update({
            vkMessageId: msgId,
            vkAttachments: attachments.length > 0 ? attachments.join(',') : '',
            status: "pending",
            processedAt: Date.now(),
            botProcessed: true,
            autoReview: autoReview,
            photoCount: attachments.length
        });
        
        processedReports.add(reportId);
        
    } catch (error) {
        console.error(`❌ Ошибка отчета ${reportId}:`, error);
        
        // Если ошибка из-за длины сообщения, пробуем отправить без авто-оценки
        if (error.code === 914 || error.message.includes('too long')) {
            console.log(`[REPORT] Отправляю отчет ${reportId} без авто-оценки`);
            
            const shortText = 
                `📝 НОВЫЙ ОТЧЕТ\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `👤 Ник: ${report.author || "—"}\n` +
                `📊 Баллы: ${report.score || 0}\n` +
                `📎 Фото: ${report.imgs?.length || 0} шт.\n` +
                `⚠️ Авто-анализ не поместился в сообщение`;
            
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
                message: shortText,
                keyboard: keyboard
            });
            
            await db.ref(`reports/${reportId}`).update({
                vkMessageId: msgId,
                status: "pending",
                processedAt: Date.now(),
                botProcessed: true,
                photoCount: 0
            });
        }
    }
}

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
    
    // Новая команда для проверки модулей
    if (text === "/status") {
        const statusMessage = 
            `🤖 СТАТУС БОТА\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `🛒 Обработано покупок: ${processedPurchases.size}\n` +
            `🎰 Обработано рулетки: ${processedRoulette.size}\n` +
            `📝 Обработано отчетов: ${processedReports.size}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `✅ Все системы работают`;
        
        return ctx.send(statusMessage);
    }
});

// =======================
// ОБРАБОТКА КНОПОК ОТЧЕТОВ
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
        
        // Сохраняем авто-оценку если она была
        const autoReview = report.autoReview ? `\n\n${report.autoReview}` : "";
        
        const newText = 
            `📝 ОТЧЕТ ${isApproved ? 'ОДОБРЕН' : 'ОТКЛОНЕН'}\n\n` +
            `👤 Ник: ${report.author || "—"}\n` +
            `🔰 Должность: ${report.role || "—"}\n` +
            `📅 Дата: ${report.date || "—"}\n\n` +
            `🛠 Работа: ${report.work || "—"}\n` +
            `⚖️ Наказания: ${report.punishments || "Нет"}\n` +
            `📊 Баллы: ${report.score || 0}\n\n` +
            `${autoReview}\n\n` +
            `${statusIcon}\n👤 Проверил: ${adminName}`;

        try {
            // Получаем текущее сообщение для сохранения attachment
            const messages = await vk.api.messages.getByConversationMessageId({
                peer_id: ctx.peerId,
                conversation_message_ids: [ctx.conversationMessageId]
            });
            
            if (messages.items && messages.items[0]) {
                const currentMessage = messages.items[0];
                const currentAttachments = currentMessage.attachments || [];
                const attachmentStrings = currentAttachments.map(att => {
                    if (att.type === 'photo' && att.photo) {
                        return `photo${att.photo.owner_id}_${att.photo.id}${att.photo.access_key ? `_${att.photo.access_key}` : ''}`;
                    }
                    return null;
                }).filter(Boolean);
                
                await vk.api.messages.edit({
                    peer_id: ctx.peerId,
                    conversation_message_id: ctx.conversationMessageId,
                    message: newText,
                    attachment: attachmentStrings.join(','),
                    keyboard: Keyboard.builder().inline().toString()
                });
                
            } else if (report.vkAttachments) {
                await vk.api.messages.edit({
                    peer_id: ctx.peerId,
                    conversation_message_id: ctx.conversationMessageId,
                    message: newText,
                    attachment: report.vkAttachments,
                    keyboard: Keyboard.builder().inline().toString()
                });
            } else {
                await vk.api.messages.edit({
                    peer_id: ctx.peerId,
                    conversation_message_id: ctx.conversationMessageId,
                    message: newText,
                    keyboard: Keyboard.builder().inline().toString()
                });
            }
            
        } catch (editError) {
            console.error("Ошибка редактирования:", editError);
        }

    } catch (e) { 
        console.error("Ошибка кнопок:", e); 
    }
});

// =======================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// =======================

async function getChatId() {
    const peerIdSnap = await db.ref("settings/chatPeerId").once("value");
    return peerIdSnap.val();
}

// =======================
// ЗАПУСК БОТА
// =======================

async function startBot() {
    try {
        await initializeExistingData();
        await vk.updates.start();
        
        console.log('🤖 Бот успешно запущен');
        console.log('🛒 Модуль покупок: АКТИВЕН');
        console.log('🎰 Модуль рулетки: АКТИВЕН');
        console.log('🧠 Модуль авто-оценки: АКТИВЕН (встроен в отчеты)');
        console.log('📊 Команды: /bind, /id, /info [ник], /status');
        
    } catch (error) {
        console.error('❌ Ошибка запуска:', error);
    }
}

startBot();

// Веб-сервер для проверки
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`✅ Бот работает\n🛒 Покупок: ${processedPurchases.size}\n🎰 Рулетка: ${processedRoulette.size}\n📝 Отчетов: ${processedReports.size}\n🧠 Авто-оценка встроена в отчеты`);
}).listen(process.env.PORT || 3000);

console.log(`🌐 Сервер на порту ${process.env.PORT || 3000}`);
