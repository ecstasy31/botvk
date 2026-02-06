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

// Ссылка на ваш сайт для кнопки в /info
const SITE_URL = "https://ваш-сайт.com"; // ⚠️ ЗАМЕНИТЕ НА ССЫЛКУ ВАШЕГО САЙТА

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
        databaseURL: "https://modersekb-default-rtdb.firebaseio.com"
    });
}

const db = admin.database();

console.log("🚀 Бот запущен. Ожидание обновлений...");

// =======================
// КОМАНДЫ (BIND, ID, INFO)
// =======================
vk.updates.on("message_new", async (ctx) => {
    if (ctx.isOutbox || !ctx.text) return;
    const text = ctx.text.trim();

    if (text === "/bind") {
        await db.ref("settings/chatPeerId").set(ctx.peerId);
        return ctx.send(`✅ Беседа привязана к peer_id: ${ctx.peerId}`);
    }

    if (text === "/id") {
        return ctx.send(`peer_id: ${ctx.peerId}`);
    }

    if (text.toLowerCase().startsWith("/info")) {
        const nickRaw = text.replace(/^\/info\s*/i, "").trim();
        if (!nickRaw) return ctx.send("❗ Используй: /info Ник");

        // Получаем все данные одним запросом для скорости
        const [usersSnap, reportsSnap] = await Promise.all([
            db.ref("users").once("value"),
            db.ref("reports").once("value")
        ]);

        const users = usersSnap.val() || {};
        const reports = reportsSnap.val() || {};

        // 🔍 УЛУЧШЕННЫЙ ПОИСК (Игнорируем регистр ключей)
        // Ищем ключ объекта users, который совпадает с введенным ником
        const targetKey = Object.keys(users).find(k => k.toLowerCase() === nickRaw.toLowerCase());
        const userEntry = targetKey ? users[targetKey] : null;
        
        // Фильтруем отчеты
        const userReports = Object.values(reports).filter(r => (r.author || "").toLowerCase() === nickRaw.toLowerCase());

        if (!userEntry && userReports.length === 0) {
            return ctx.send(`❌ Модератор "${nickRaw}" не найден в базе.`);
        }

        const lastReport = userReports.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))[0];
        // Считаем средний балл, защищаясь от NaN
        const avgScore = userReports.length 
            ? Math.round(userReports.reduce((s, r) => s + (Number(r.score) || 0), 0) / userReports.length) 
            : 0;

        // Создаем кнопку ссылки
        const infoKeyboard = Keyboard.builder()
            .inline()
            .urlButton({
                label: "🌍 Открыть таблицу",
                url: SITE_URL
            });

        return ctx.send({
            message: `📋 ИНФОРМАЦИЯ О МОДЕРАТОРЕ\n\n` +
            `👤 Ник: ${targetKey || nickRaw}\n` + // Используем найденный ключ (правильный регистр)
            `📧 Почта: ${userEntry?.email || "не привязана"}\n` + 
            `🎖 Роль: ${userEntry?.role || lastReport?.role || "не указана"}\n` +
            `🟢 Статус: ${userEntry?.active ? "активен" : "неактивен"}\n\n` +
            `📊 Баллы: ${userEntry?.score || 0}\n` +
            `📝 Отчетов: ${userReports.length}\n` +
            `📅 Последний отчет: ${lastReport?.date || "нет"}\n` +
            `📈 Средний балл: ${avgScore}`,
            keyboard: infoKeyboard
        });
    }
});

// =======================
// ОБРАБОТКА КНОПОК (БАЛЛЫ И СТАТУСЫ)
// =======================
vk.updates.on("message_event", async (ctx) => {
    try {
        const payload = ctx.eventPayload;
        if (!payload || !payload.reportId) return;

        // 1. Сразу гасим "крутилку" на кнопке
        await ctx.answer().catch(() => {});

        const { reportId, action } = payload;
        const reportRef = db.ref(`reports/${reportId}`);
        const snap = await reportRef.once("value");
        const report = snap.val();

        // Проверка: существует ли отчет и не обработан ли он уже
        if (!report) {
            return ctx.send({ message: "⚠ Ошибка: Отчет не найден в базе.", ephemeral: true });
        }
        if (report.status !== "pending") {
             // ephemeral: true показывает сообщение только нажавшему
            return ctx.send({ message: "⚠ Этот отчет уже был проверен.", ephemeral: true });
        }

        const [adminUser] = await vk.api.users.get({ user_ids: ctx.userId });
        const adminName = `${adminUser.first_name} ${adminUser.last_name}`;
        const isApproved = action === "ok";

        // =======================
        // 🔥 НАЧИСЛЕНИЕ БАЛЛОВ
        // =======================
        if (isApproved && report.author) {
            const pointsToAdd = Number(report.score) || 0;
            
            // Находим пользователя в базе (с учетом регистра, если ключ в базе = ник)
            // Лучше использовать точное имя из отчета report.author
            const userRef = db.ref(`users/${report.author}`);
            
            // Используем транзакцию, чтобы безопасно прибавить число
            await userRef.child('score').transaction((currentScore) => {
                return (currentScore || 0) + pointsToAdd;
            });
            console.log(`💰 Выдано ${pointsToAdd} баллов пользователю ${report.author}`);
        }

        // Обновляем статус отчета
        await reportRef.update({
            status: isApproved ? "approved" : "rejected",
            checker: adminName,
            checkTime: Date.now()
        });

        // Редактируем сообщение (убираем кнопки)
        const statusIcon = isApproved ? "✅ ОДОБРЕНО" : "❌ ОТКЛОНЕНО";
        const newText = `${report.vkText}\n\n${statusIcon}\n👤 Проверил: ${adminName}`;

        await vk.api.messages.edit({
            peer_id: ctx.peerId,
            conversation_message_id: ctx.conversationMessageId,
            message: newText,
            attachment: ctx.eventPayload.attachments || [], // Сохраняем вложения, если были переданы
            keyboard: Keyboard.builder().inline().toString() // Пустая клавиатура, чтобы убрать кнопки
        });

    } catch (e) {
        console.error("❌ Ошибка в кнопках (message_event):", e.message);
        // Не отправляем ошибку пользователю, чтобы не спамить в чат
    }
});

// =======================
// НОВЫЕ ОТЧЕТЫ (ФОТО И ОТПРАВКА)
// =======================
db.ref("reports").on("child_added", async (snap) => {
    try {
        const report = snap.val();
        const reportId = snap.key;

        // ИСПРАВЛЕНО: Убрана проверка на report.status, так как новые отчеты часто приходят со статусом "pending"
        if (report.vkMessageId) return;

        // Ждем 1 секунду, чтобы убедиться, что firebase записал все поля
        await new Promise(r => setTimeout(r, 1000));

        const peerIdSnap = await db.ref("settings/chatPeerId").once("value");
        const peerId = peerIdSnap.val();
        
        if (!peerId) {
            console.log("⚠ ID беседы не установлен. Введите /bind в беседе.");
            return;
        }

        const text =
            `📝 НОВЫЙ ОТЧЕТ\n\n` +
            `👤 Ник: ${report.author}\n` +
            `🔰 Должность: ${report.role}\n` +
            `📅 Дата: ${report.date}\n\n` +
            `🛠 Работа: ${report.work}\n` +
            `⚖️ Наказания: ${report.punishments || "Нет"}\n` +
            `📊 Баллы к выдаче: ${report.score}`;

        const attachments = [];
        if (report.photos) {
            const photoUrls = Object.values(report.photos);
            
            const uploadPromises = photoUrls.map(async (url) => {
                try {
                    const response = await fetch(url);
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    
                    const buffer = Buffer.from(await response.arrayBuffer());
                    
                    const photo = await vk.upload.messagePhoto({
                        source: { value: buffer },
                        peer_id: peerId 
                    });
                    
                    return photo; 
                } catch (err) {
                    console.error("Ошибка загрузки фото:", err.message);
                    return null;
                }
            });

            const uploadedPhotos = await Promise.all(uploadPromises);
            
            uploadedPhotos.forEach(p => {
                if(p) attachments.push(p.toString());
            });
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
            });

        // ИСПРАВЛЕНО: random_id теперь 0 (vk-io сам сгенерирует корректное число)
        const msg = await vk.api.messages.send({
            peer_id: Number(peerId),
            random_id: 0, 
            message: text,
            attachment: attachments,
            keyboard: keyboard.toString()
        });

        // Записываем ID сообщения и обновляем статус
        await db.ref(`reports/${reportId}`).update({
            vkMessageId: msg,
            vkText: text,
            status: "pending"
        });

        console.log(`✅ Отчет ${reportId} отправлен в беседу.`);

    } catch (err) {
        console.error("❌ Ошибка при обработке нового отчета:", err);
    }
});

// =======================
// ЗАПУСК
// =======================
vk.updates.start().then(() => console.log('🤖 VK Polling started')).catch(console.error);

http.createServer((_, res) => {
    res.writeHead(200);
    res.end("Bot is alive");
}).listen(process.env.PORT || 3000);
