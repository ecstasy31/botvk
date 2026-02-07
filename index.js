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
        
        if (!userData) return { username: userId, rank: "Не указано" };
        
        return {
            username: userData.nick || userId,
            rank: userData.rank || "Не указано",
            score: userData.score || 0
        };
    } catch (error) {
        console.error(`[USER INFO] Ошибка получения данных пользователя ${userId}:`, error);
        return { username: userId, rank: "Не указано" };
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
// ОБРАБОТКА ПОКУПОК В МАГАЗИНЕ (С САЙТА)
// =======================

// Отслеживаем покупки товаров из магазина на сайте
db.ref("shop_purchases").on("child_added", async (snap) => {
    if (!isBotReady) return;
    
    const purchaseId = snap.key;
    const purchase = snap.val();
    
    // Проверяем, не обрабатывалась ли покупка уже
    if (purchase.vkNotified) {
        console.log(`[SHOP PURCHASE] Покупка ${purchaseId} уже была уведомлена`);
        return;
    }
    
    console.log(`[SHOP PURCHASE] Обрабатываю покупку в магазине: ${purchaseId}`);
    await processShopPurchase(purchaseId, purchase);
});

async function processShopPurchase(purchaseId, purchase) {
    try {
        const peerId = await getChatId();
        if (!peerId) return;

        // Получаем информацию о пользователе
        const userInfo = await getUserInfo(purchase.userId);
        
        // Формируем сообщение о покупке
        let message = `🛒 НОВАЯ ПОКУПКА В МАГАЗИНЕ\n\n`;
        
        message += `👤 Покупатель: ${userInfo.username}\n`;
        message += `🏢 Должность: ${userInfo.rank}\n`;
        
        if (purchase.itemName) {
            message += `📦 Товар: ${purchase.itemName}\n`;
        }
        
        if (purchase.price !== undefined) {
            message += `💰 Стоимость: ${purchase.price} баллов\n`;
        }
        
        if (userInfo.score !== undefined) {
            message += `🏦 Баланс до покупки: ${userInfo.score + purchase.price}\n`;
            message += `🏦 Баланс после покупки: ${userInfo.score}\n`;
        }
        
        if (purchase.timestamp) {
            const date = new Date(purchase.timestamp);
            message += `🕒 Время: ${date.toLocaleString("ru-RU")}\n`;
        }
        
        // Добавляем разделитель
        message += `\n━━━━━━━━━━━━━━━━━━━\n`;
        
        message += `🔗 Профиль: ${SITE_URL}/#profile?user=${encodeURIComponent(purchase.userId)}`;

        await vk.api.messages.send({
            peer_id: Number(peerId),
            random_id: Math.floor(Math.random() * 2000000000),
            message: message
        });
        
        console.log(`✅ Уведомление о покупке ${purchaseId} отправлено`);
        
        // Помечаем покупку как обработанную
        await db.ref(`shop_purchases/${purchaseId}`).update({
            vkNotified: true,
            vkNotificationTime: Date.now()
        });
        
    } catch (error) {
        console.error(`❌ Ошибка при обработке покупки ${purchaseId}:`, error);
    }
}

// Также отслеживаем логи покупок, которые записываются функцией buyItem()
db.ref("logs").on("child_added", async (snap) => {
    if (!isBotReady) return;
    
    const logId = snap.key;
    const log = snap.val();
    
    // Пропускаем логи, которые не о покупках
    if (!log.action || !log.action.includes("КУПИЛ В МАГАЗИНЕ:")) return;
    
    // Проверяем, не обрабатывался ли лог уже
    if (log.vkNotified) {
        console.log(`[SHOP LOG] Лог ${logId} уже был обработан`);
        return;
    }
    
    console.log(`[SHOP LOG] Обрабатываю лог покупки: ${logId}`);
    
    // Создаем запись о покупке
    const purchaseData = {
        userId: log.target,
        itemName: log.action.replace("КУПИЛ В МАГАЗИНЕ: ", ""),
        price: 0, // Цену нужно будет извлечь из лога или другого источника
        timestamp: Date.now(),
        vkNotified: true,
        vkNotificationTime: Date.now()
    };
    
    // Сохраняем покупку для истории
    await db.ref(`shop_purchases/${logId}`).set(purchaseData);
    
    // Отправляем уведомление о покупке
    try {
        const peerId = await getChatId();
        if (!peerId) return;
        
        const userInfo = await getUserInfo(log.target);
        
        let message = `🛒 ПОКУПКА ИЗ ЛОГОВ\n\n`;
        message += `👤 Покупатель: ${userInfo.username}\n`;
        message += `🏢 Должность: ${userInfo.rank}\n`;
        message += `📦 Товар: ${log.action.replace("КУПИЛ В МАГАЗИНЕ: ", "")}\n`;
        message += `🕒 Время: ${new Date(log.time).toLocaleString("ru-RU")}\n`;
        message += `👤 Инициатор: ${log.by}\n`;
        
        message += `\n━━━━━━━━━━━━━━━━━━━\n`;
        message += `🔗 Профиль: ${SITE_URL}/#profile?user=${encodeURIComponent(log.target)}`;
        
        await vk.api.messages.send({
            peer_id: Number(peerId),
            random_id: Math.floor(Math.random() * 2000000000),
            message: message
        });
        
        console.log(`✅ Уведомление о покупке из логов отправлено`);
        
    } catch (error) {
        console.error(`❌ Ошибка при обработке лога покупки:`, error);
    }
});

// =======================
// ОБРАБОТКА РУЛЕТКИ (С САЙТА)
// =======================

// Отслеживаем результаты рулетки с сайта
db.ref("roulette_spins").on("child_added", async (snap) => {
    if (!isBotReady) return;
    
    const spinId = snap.key;
    const spin = snap.val();
    
    // Проверяем, не обрабатывалась ли рулетка уже
    if (spin.vkNotified) {
        console.log(`[ROULETTE SPIN] Рулетка ${spinId} уже была уведомлена`);
        return;
    }
    
    console.log(`[ROULETTE SPIN] Обрабатываю результат рулетки: ${spinId}`);
    await processRouletteSpin(spinId, spin);
});

async function processRouletteSpin(spinId, spin) {
    try {
        const peerId = await getChatId();
        if (!peerId) return;

        // Получаем информацию о пользователе
        const userInfo = await getUserInfo(spin.userId);
        
        // Определяем иконку результата
        let resultIcon = "🎰";
        let resultText = "";
        
        if (spin.result === "win_score") {
            resultIcon = "🎉";
            resultText = `Выиграл ${spin.winAmount || 0} баллов`;
        } else if (spin.result === "win_item") {
            resultIcon = "💰";
            resultText = `Выиграл товар: ${spin.winItem || "Неизвестный товар"}`;
        } else if (spin.result === "lose") {
            resultIcon = "😔";
            resultText = "Ничего не выиграл";
        } else if (spin.result === "jackpot") {
            resultIcon = "🏆";
            resultText = "ДЖЕКПОТ!";
        }
        
        // Формируем сообщение о рулетке
        let message = `${resultIcon} РЕЗУЛЬТАТ РУЛЕТКИ\n\n`;
        
        message += `👤 Игрок: ${userInfo.username}\n`;
        message += `🏢 Должность: ${userInfo.rank}\n`;
        
        if (spin.bet !== undefined) {
            message += `🎯 Ставка: ${spin.bet} баллов\n`;
        }
        
        if (spin.winAmount !== undefined && spin.result === "win_score") {
            message += `💰 Выигрыш: ${spin.winAmount} баллов\n`;
        }
        
        if (spin.winItem && spin.result === "win_item") {
            message += `🎁 Выигрыш: ${spin.winItem}\n`;
        }
        
        message += `📊 Результат: ${resultText}\n`;
        
        if (spin.balanceBefore !== undefined) {
            message += `🏦 Баланс до: ${spin.balanceBefore} баллов\n`;
        }
        
        if (spin.balanceAfter !== undefined) {
            message += `🏦 Баланс после: ${spin.balanceAfter} баллов\n`;
        }
        
        if (spin.timestamp) {
            const date = new Date(spin.timestamp);
            message += `🕒 Время: ${date.toLocaleString("ru-RU")}\n`;
        }
        
        // Добавляем разделитель
        message += `\n━━━━━━━━━━━━━━━━━━━\n`;
        
        message += `🔗 Профиль: ${SITE_URL}/#profile?user=${encodeURIComponent(spin.userId)}`;

        await vk.api.messages.send({
            peer_id: Number(peerId),
            random_id: Math.floor(Math.random() * 2000000000),
            message: message
        });
        
        console.log(`✅ Уведомление о рулетке ${spinId} отправлено`);
        
        // Помечаем результат рулетки как обработанный
        await db.ref(`roulette_spins/${spinId}`).update({
            vkNotified: true,
            vkNotificationTime: Date.now()
        });
        
    } catch (error) {
        console.error(`❌ Ошибка при обработке рулетки ${spinId}:`, error);
    }
}

// Также отслеживаем логи рулетки
db.ref("logs").on("child_added", async (snap) => {
    if (!isBotReady) return;
    
    const logId = snap.key;
    const log = snap.val();
    
    // Пропускаем логи, которые не о рулетке
    if (!log.action || !log.action.startsWith("РУЛЕТКА:")) return;
    
    // Проверяем, не обрабатывался ли лог уже
    if (log.vkNotified) {
        console.log(`[ROULETTE LOG] Лог ${logId} уже был обработан`);
        return;
    }
    
    console.log(`[ROULETTE LOG] Обрабатываю лог рулетки: ${logId}`);
    
    // Создаем запись о рулетке
    const rouletteData = {
        userId: log.target,
        result: "lose", // По умолчанию
        resultText: log.action.replace("РУЛЕТКА: ", ""),
        timestamp: Date.now(),
        vkNotified: true,
        vkNotificationTime: Date.now()
    };
    
    // Определяем тип результата
    if (log.action.includes("ВЫИГРЫШ:")) {
        if (log.action.includes("баллов")) {
            rouletteData.result = "win_score";
            // Пытаемся извлечь количество баллов
            const match = log.action.match(/ВЫИГРЫШ:\s*(\d+)\s*баллов/);
            if (match) rouletteData.winAmount = parseInt(match[1]);
        } else {
            rouletteData.result = "win_item";
            rouletteData.winItem = log.action.replace("РУЛЕТКА: ВЫИГРЫШ: ", "");
        }
    } else if (log.action.includes("ничего не выпало") || log.action.includes("Увы, ничего")) {
        rouletteData.result = "lose";
    }
    
    // Сохраняем результат рулетки для истории
    await db.ref(`roulette_spins/${logId}`).set(rouletteData);
    
    // Отправляем уведомление о рулетке
    try {
        const peerId = await getChatId();
        if (!peerId) return;
        
        const userInfo = await getUserInfo(log.target);
        
        let message = `🎰 РУЛЕТКА ИЗ ЛОГОВ\n\n`;
        message += `👤 Игрок: ${userInfo.username}\n`;
        message += `🏢 Должность: ${userInfo.rank}\n`;
        message += `📊 Результат: ${log.action.replace("РУЛЕТКА: ", "")}\n`;
        message += `🕒 Время: ${new Date(log.time).toLocaleString("ru-RU")}\n`;
        message += `👤 Инициатор: ${log.by}\n`;
        
        message += `\n━━━━━━━━━━━━━━━━━━━\n`;
        message += `🔗 Профиль: ${SITE_URL}/#profile?user=${encodeURIComponent(log.target)}`;
        
        await vk.api.messages.send({
            peer_id: Number(peerId),
            random_id: Math.floor(Math.random() * 2000000000),
            message: message
        });
        
        console.log(`✅ Уведомление о рулетке из логов отправлено`);
        
    } catch (error) {
        console.error(`❌ Ошибка при обработке лога рулетки:`, error);
    }
});

// =======================
// ОБРАБОТКА ДРУГИХ ДЕЙСТВИЙ С БАЛЛАМИ
// =======================

// Отслеживаем другие действия с баллами (пропуск собрания, снятие выговора и т.д.)
db.ref("logs").on("child_added", async (snap) => {
    if (!isBotReady) return;
    
    const logId = snap.key;
    const log = snap.val();
    
    // Пропускаем логи, которые уже обработаны
    if (log.vkNotified) return;
    
    // Определяем, нужно ли обрабатывать этот лог
    const actionsToTrack = [
        "Пропуск собрания",
        "Снял выговор себе",
        "Взял неактив",
        "Вышел из неактива",
        "Сменил ник",
        "Подтвердил почту"
    ];
    
    const shouldTrack = actionsToTrack.some(action => log.action && log.action.includes(action));
    if (!shouldTrack) return;
    
    console.log(`[ACTION LOG] Обрабатываю действие: ${logId} - ${log.action}`);
    
    // Отправляем уведомление о действии
    try {
        const peerId = await getChatId();
        if (!peerId) return;
        
        const userInfo = await getUserInfo(log.target);
        
        // Определяем иконку для действия
        let actionIcon = "📝";
        if (log.action.includes("Пропуск собрания")) actionIcon = "⏰";
        else if (log.action.includes("выговор")) actionIcon = "⚠️";
        else if (log.action.includes("неактив
