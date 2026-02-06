import { VK, Keyboard } from "vk-io";
import admin from "firebase-admin";
import fetch from "node-fetch";
import http from "http";

// =======================
// НАСТРОЙКИ (ИЗ ОКРУЖЕНИЯ)
// =======================
const vk = new VK({
    token: process.env.VK_TOKEN,
    apiVersion: "5.199",
    pollingGroupId: Number(process.env.VK_GROUP_ID)
});

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
        databaseURL: "https://modersekb-default-rtdb.firebaseio.com"
    });
}

const db = admin.database();
console.log("🚀 Бот полностью готов. Ожидаю отчеты и команды...");

// =======================
// ОСНОВНЫЕ КОМАНДЫ
// =======================
vk.updates.on("message_new", async (ctx) => {
    if (ctx.isOutbox || !ctx.text) return;
    const text = ctx.text.trim().toLowerCase();

    // Привязка беседы
    if (text === "/bind") {
        await db.ref("settings/chatPeerId").set(ctx.peerId);
        return ctx.send(`✅ Беседа успешно привязана к системе.`);
    }

    // Информация о модераторе
    if (text.startsWith("/info")) {
        const nickRaw = ctx.text.replace(/\/info\s*/i, "").trim();
        if (!nickRaw) return ctx.send("❗ Ошибка. Пиши: /info Ник");

        const usersSnap = await db.ref("users").once("value");
        const users = usersSnap.val() || {};

        // Поиск (без учета регистра)
        const targetNick = Object.keys(users).find(k => k.toLowerCase() === nickRaw.toLowerCase());
        const user = targetNick ? users[targetNick] : null;

        if (!user) return ctx.send(`❌ Модератор "${nickRaw}" не найден.`);

        const infoKeyboard = Keyboard.builder().inline()
            .callbackButton({
                label: "📊 Таблица всех модераторов",
                payload: { action: "show_table" },
                color: "primary"
            });

        return ctx.send({
            message: `👤 ИНФО: ${targetNick}\n\n` +
            `📧 Почта: ${user.email || "не привязана"}\n` +
            `🎖 Роль: ${user.role || "Модератор"}\n` +
            `📊 Баллы: ${user.score || 0}\n` +
            `📝 Всего отчетов: ${user.reportsCount || 0}\n` +
            `🟢 Статус: ${user.active ? "Активен" : "Неактивен"}`,
            keyboard: infoKeyboard
        });
    }
});

// =======================
// ОБРАБОТКА КНОПОК
// =======================
vk.updates.on("message_event", async (ctx) => {
    try {
        const payload = ctx.eventPayload;
        if (!payload) return;

        // Отключаем "крутилку" на кнопке сразу
        await ctx.answer().catch(() => {});

        // 1. ПОКАЗ ТАБЛИЦЫ
        if (payload.action === "show_table") {
            const usersSnap = await db.ref("users").once("value");
            const users = usersSnap.val() || {};

            const sorted = Object.entries(users)
                .map(([name, data]) => ({ name, score: data.score || 0, role: data.role || "Мод" }))
                .sort((a, b) => b.score - a.score)
                .slice(0, 20); // Топ-20

            let tableText = "📂 ТАБЛИЦА МОДЕРАЦИИ (ТОП-20):\n\n";
            sorted.forEach((u, i) => {
                tableText += `${i + 1}. ${u.name} | ${u.role} — ${u.score} баллов\n`;
            });

            return vk.api.messages.send({
                peer_id: ctx.peerId,
                random_id: 0,
                message: tableText
            });
        }

        // 2. ОДОБРЕНИЕ / ОТКАЗ
        if (payload.reportId) {
            const { reportId, action } = payload;
            const reportRef = db.ref(`reports/${reportId}`);
            const snap = await reportRef.once("value");
            const report = snap.val();

            // Если отчет уже проверен, не даем нажать еще раз
            if (!report || report.status !== "pending") return;

            const [adminUser] = await vk.api.users.get({ user_ids: ctx.userId });
            const adminName = `${adminUser.first_name} ${adminUser.last_name}`;
            const approved = action === "ok";

            if (approved) {
                // ПРИБАВЛЯЕМ БАЛЛЫ В БАЗУ САЙТА
                const userRef = db.ref(`users/${report.author}/score`);
                await userRef.transaction(current => (current || 0) + Number(report.score));
            }

            // Обновляем статус в базе
            await reportRef.update({
                status: approved ? "approved" : "rejected",
                checker: adminName
            });

            // Редактируем сообщение, убираем кнопки
            await vk.api.messages.edit({
                peer_id: ctx.peerId,
                conversation_message_id: ctx.conversationMessageId,
                message: `${report.vkText}\n\n${approved ? "✅ ОДОБРЕНО" : "❌ ОТКЛОНЕНО"}\n👤 Проверил: ${adminName}`,
                keyboard: Keyboard.builder().inline().toString()
            });
        }
    } catch (e) {
        // Ловим ошибку тихо, без лишнего текста в консоль
        console.log("Button Error (Handled)");
    }
});

// =======================
// ОТПРАВКА ОТЧЕТОВ В ЧАТ
// =======================
db.ref("reports").on("child_added", async (snap) => {
    const report = snap.val();
    const reportId = snap.key;

    // Игнорируем если уже есть статус или сообщение в ВК (чтобы не дублировало при перезагрузке)
    if (report.status || report.vkMessageId) return;

    const peerIdSnap = await db.ref("settings/chatPeerId").once("value");
    const peerId = peerIdSnap.val();
    if (!peerId) return;

    // Текст отчета
    const text = `📝 НОВЫЙ ОТЧЕТ\n\n` +
                 `👤 Автор: ${report.author}\n` +
                 `🔰 Роль: ${report.role}\n` +
                 `📊 Баллы: ${report.score}\n` +
                 `📅 Дата: ${report.date}\n\n` +
                 `🛠 Работа: ${report.work}`;

    // Загрузка фото как вложения (аттачменты)
    const attachments = [];
    if (report.photos) {
        const photoUrls = Object.values(report.photos);
        for (const url of photoUrls) {
            try {
                const res = await fetch(url);
                const buffer = Buffer.from(await res.arrayBuffer());
                const photo = await vk.upload.messagePhoto({
                    source: { value: buffer },
                    peer_id: peerId
                });
                attachments.push(photo.toString());
            } catch (err) {
                console.log("Ошибка загрузки фото модератора");
            }
        }
    }

    try {
        const msgId = await vk.api.messages.send({
            peer_id: Number(peerId),
            random_id: Math.floor(Date.now() + Math.random() * 1000),
            message: text,
            attachment: attachments,
            keyboard: Keyboard.builder().inline()
                .callbackButton({ label: "✅ Одобрить", payload: { reportId, action: "ok" }, color: "positive" })
                .callbackButton({ label: "❌ Отказать", payload: { reportId, action: "no" }, color: "negative" })
                .toString()
        });

        // Помечаем в базе, что отчет отправлен и ждет проверки
        await db.ref(`reports/${reportId}`).update({
            vkMessageId: msgId,
            status: "pending",
            vkText: text
        });

    } catch (err) {
        console.error("Ошибка отправки отчета:", err.message);
    }
});

// Запуск сервера и бота
vk.updates.start().catch(console.error);
http.createServer((_, res) => res.end("Bot Active")).listen(process.env.PORT || 3000);
