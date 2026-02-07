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
// 1️⃣ УВЕДОМЛЕНИЕ О ПОКУПКЕ В МАГАЗИНЕ (ИСПРАВЛЕНО)
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
    
    console.log(`[SHOP] Обрабатываю покупку: ${purchaseId}`, JSON.stringify(purchase, null, 2));
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
        
        // Получаем имя пользователя по ID
        let userName = "Неизвестный пользователь";
        if (purchase.userId) {
            try {
                const [userData] = await vk.api.users.get({ user_ids: [purchase.userId] });
                if (userData) {
                    userName = `${userData.first_name} ${userData.last_name}`;
                }
            } catch (userError) {
                console.log(`[SHOP] Не удалось получить имя пользователя: ${userError.message}`);
            }
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
        
        // Форматируем сообщение (ИСПРАВЛЕНО)
        const message = 
            `🛒 ПОКУПКА В МАГАЗИНЕ\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `👤 Модератор: ${userName} (ID: ${purchase.userId || "неизвестен"})\n` +
            `🎁 Товар: ${purchase.item || "Неизвестно"}\n` +
            `💰 Стоимость: ${purchase.price || 0} баллов\n` +
            `🕐 Время: ${time}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `✅ Покупка зафиксирована в системе`;
        
        console.log(`[SHOP] Отправляю сообщение:`, message);
        
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
// 2️⃣ УВЕДОМЛЕНИЕ О РУЛЕТКЕ (ИСПРАВЛЕНО)
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
    
    console.log(`[ROULETTE] Обрабатываю спин: ${spinId}`, JSON.stringify(spin, null, 2));
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
        
        // Получаем имя пользователя по ID
        let userName = "Неизвестный игрок";
        if (spin.userId) {
            try {
                const [userData] = await vk.api.users.get({ user_ids: [spin.userId] });
                if (userData) {
                    userName = `${userData.first_name} ${userData.last_name}`;
                }
            } catch (userError) {
                console.log(`[ROULETTE] Не удалось получить имя пользователя: ${userError.message}`);
            }
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
        let resultText = spin.result || "Не определен";
        
        if (spin.result) {
            const lowerResult = spin.result.toLowerCase();
            if (lowerResult.includes("выигрыш") || lowerResult.includes("приз")) {
                resultIcon = "🎁";
            } else if (lowerResult.includes("ничего") || lowerResult.includes("проигрыш")) {
                resultIcon = "❌";
            }
        }
        
        // Форматируем сообщение (ИСПРАВЛЕНО)
        const message = 
            `${resultIcon} РЕЗУЛЬТАТ РУЛЕТКИ\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `👤 Игрок: ${userName} (ID: ${spin.userId || "неизвестен"})\n` +
            `🎯 Результат: ${resultText}\n` +
            `💰 Стоимость спина: ${spin.cost || 15} баллов\n` +
            `🕐 Время: ${time}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `🎉 Удачи в следующий раз!`;
        
        console.log(`[ROULETTE] Отправляю сообщение:`, message);
        
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
// 3️⃣ УПРОЩЕННЫЙ АВТО-АНАЛИЗ ОТЧЁТА
// =======================

function generateAutoReview(report) {
    // Простой анализ без излишеств
    const remarks = [];
    
    // Базовые метрики
    const textLength = report.work ? report.work.trim().length : 0;
    const photoCount = report.imgs && Array.isArray(report.imgs) ? report.imgs.length : 0;
    const score = Number(report.score) || 0;
    const punishments = Number(report.punishments) || 0;
    
    // Проверки
    if (textLength < 30) {
        remarks.push("• Слишком краткое описание");
    }
    
    if (photoCount === 0) {
        remarks.push("• Нет скриншотов");
    } else if (photoCount === 1) {
        remarks.push("• Мало доказательств (1 фото)");
    }
    
    if (punishments > 0 && score === 0) {
        remarks.push("• Есть наказания, но нет баллов");
    }
    
    if (score > 5 && textLength < 50) {
        remarks.push("• Высокий балл при кратком описании");
    }
    
    // Формируем отзыв
    let review = "🧠 АВТО-АНАЛИЗ\n";
    review += "━━━━━━━━━━━━━━━━━━\n";
    
    if (remarks.length > 0) {
        review += "⚠️ Внимание:\n";
        review += remarks.join('\n');
    } else {
        review += "✅ Отчёт соответствует требованиям\n";
    }
    
    review += `\n📊 Показатели:\n`;
    review += `• Длина: ${textLength} симв.\n`;
    review += `• Фото: ${photoCount} шт.\n`;
    review += `• Наказаний: ${punishments}\n`;
    review += `• Баллов: ${score}`;
    
    review += "\n━━━━━━━━━━━━━━━━━━";
    return review;
}

// =======================
// ОБРАБОТКА ОТЧЕТОВ
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
    
    console.log(`[REPORT] Обрабатываю отчет ${reportId}`, JSON.stringify(report, null, 2));
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
        
        // Основное сообщение отчета (упрощенное)
        const reportText = 
            `📝 НОВЫЙ ОТЧЕТ\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `👤 Ник: ${report.author || "—"}\n` +
            `🔰 Должность: ${report.role || "—"}\n` +
            `📅 Дата: ${report.date || "—"}\n\n` +
            `${autoReview}\n\n` +
            `⚖️ Наказания: ${report.punishments || "Нет"}\n` +
            `📊 Баллы: ${report.score || 0}`;
        
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
        
        console.log(`✅ Отчет ${reportId} отправлен`);
        
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
        
        // Если ошибка из-за длины сообщения, отправляем еще более краткую версию
        if (error.code === 914 || error.message.includes('too long')) {
            console.log(`[REPORT] Отправляю краткий отчет ${reportId}`);
            
            const shortText = 
                `📝 НОВЫЙ ОТЧЕТ\n` +
                `━━━━━━━━━━━━━━━━━━\n` +
                `👤 Ник: ${report.author || "—"}\n` +
                `📊 Баллы: ${report.score || 0}\n` +
                `📎 Фото: ${report.imgs?.length || 0} шт.\n` +
                `⚠️ Подробности в системе`;
            
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
    
    // Команда для проверки модулей
    if (text === "/status") {
        const statusMessage = 
            `🤖 СТАТУС БОТА\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `🛒 Обработано покупок: ${processedPurchases.size}\n` +
            `🎰 Обработано рулетки: ${processedRoulette.size}\n` +
            `📝 Обработано отчетов: ${processedReports.size}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `📡 Проверка работы...\n\n`;
        
        // Проверяем активность в реальном времени
        const testPromises = [
            db.ref("shop_purchases").limitToLast(1).once("value"),
            db.ref("roulette_spins").limitToLast(1).once("value"),
            db.ref("reports").limitToLast(1).once("value")
        ];
        
        try {
            const results = await Promise.all(testPromises);
            const [lastPurchase, lastRoulette, lastReport] = results;
            
            statusMessage += `🛒 Последняя покупка: ${lastPurchase.exists() ? 'есть' : 'нет'}\n`;
            statusMessage += `🎰 Последняя рулетка: ${lastRoulette.exists() ? 'есть' : 'нет'}\n`;
            statusMessage += `📝 Последний отчет: ${lastReport.exists() ? 'есть' : 'нет'}\n`;
            statusMessage += `━━━━━━━━━━━━━━━━━━\n`;
            statusMessage += `✅ Все системы работают`;
            
        } catch (error) {
            statusMessage += `❌ Ошибка проверки: ${error.message}`;
        }
        
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
            `📝 ОТЧЕТ ${isApproved ? 'ОДОБРЕН' : 'ОТКЛОНЕН'}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `👤 Ник: ${report.author || "—"}\n` +
            `🔰 Должность: ${report.role || "—"}\n` +
            `📅 Дата: ${report.date || "—"}\n` +
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
// ЗАПУСК БОТА
// =======================

async function startBot() {
    try {
        await initializeExistingData();
        await vk.updates.start();
        
        console.log('🤖 Бот успешно запущен');
        console.log('🛒 Модуль покупок: АКТИВЕН');
        console.log('🎰 Модуль рулетки: АКТИВЕН');
        console.log('🧠 Модуль авто-анализа: АКТИВЕН (упрощенный)');
        console.log('📊 Команды: /bind, /id, /info [ник], /status');
        
    } catch (error) {
        console.error('❌ Ошибка запуска:', error);
    }
}

startBot();

// Веб-сервер для проверки
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`✅ Бот работает\n🛒 Покупок: ${processedPurchases.size}\n🎰 Рулетка: ${processedRoulette.size}\n📝 Отчетов: ${processedReports.size}\n🧠 Авто-анализ упрощен`);
}).listen(process.env.PORT || 3000);

console.log(`🌐 Сервер на порту ${process.env.PORT || 3000}`);
