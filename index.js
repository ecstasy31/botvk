import { VK, Keyboard } from "vk-io";
import admin from "firebase-admin";
import fetch from "node-fetch";
import http from "http";

// =======================
// НАСТРОЙКИ
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
console.log("🚀 Бот запущен в режиме ОТЛАДКИ. Жду команду /bind или новый отчет...");

// =======================
// КОМАНДЫ
// =======================
vk.updates.on("message_new", async (ctx) => {
    if (ctx.isOutbox || !ctx.text) return;
    const text = ctx.text.trim();

    if (text === "/bind") {
        await db.ref("settings/chatPeerId").set(ctx.peerId);
        console.log(`✅ ID беседы сохранен: ${ctx.peerId}`);
        return ctx.send(`✅ Беседа привязана к peer_id: ${ctx.peerId}\nТеперь отчеты будут приходить сюда.`);
    }

    if (text === "/id") return ctx.send(`peer_id: ${ctx.peerId}`);

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

        if (!userEntry && userReports.length === 0) return ctx.send(`❌ Модератор "${nickRaw}" не найден.`);

        const infoKeyboard = Keyboard.builder().inline()
            .callbackButton({ label: "📊 Топ модераторов", payload: { action: "get_table" }, color: "primary" });

        return ctx.send({
            message: `👤 Ник: ${targetKey || nickRaw}\n📊 Баллы: ${userEntry?.score || 0}\n📝 Отчетов: ${userReports.length}`,
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

        if (payload.action === "get_table") {
            const users = (await db.ref("users").once("value")).val() || {};
            const sortedUsers = Object.entries(users)
                .map(([nick, data]) => ({ nick, score: Number(data.score) || 0 }))
                .sort((a, b) => b.score - a.score).slice(0, 15);
            
            let tableText = "📊 ТАБЛИЦА ЛИДЕРОВ:\n";
            sortedUsers.forEach((u, i) => tableText += `${i+1}. ${u.nick} — ${u.score}\n`);
            
            await ctx.answer();
            return vk.api.messages.send({ peer_id: ctx.peerId, random_id: 0, message: tableText });
        }

        if (payload.reportId) {
            await ctx.answer().catch(() => {});
            const { reportId, action } = payload;
            const reportRef = db.ref(`reports/${reportId}`);
            const report = (await reportRef.once("value")).val();

            if (!report || report.status !== "pending") return ctx.send({ message: "⚠ Уже обработано.", ephemeral: true });

            const [adminUser] = await vk.api.users.get({ user_ids: ctx.userId });
            const adminName = `${adminUser.first_name} ${adminUser.last_name}`;
            const isApproved = action === "ok";

            if (isApproved && report.author) {
                await db.ref(`users/${report.author}/score`).transaction(s => (s || 0) + (Number(report.score) || 0));
            }

            await reportRef.update({ status: isApproved ? "approved" : "rejected", checker: adminName });

            await vk.api.messages.edit({
                peer_id: ctx.peerId, conversation_message_id: ctx.conversationMessageId,
                message: `${report.vkText}\n\n${isApproved ? "✅ ОДОБРЕНО" : "❌ ОТКЛОНЕНО"}\n👤 Проверил: ${adminName}`,
                keyboard: Keyboard.builder().inline().toString()
            });
        }
    } catch (e) { console.error("Ошибка кнопок:", e); }
});

// =======================
// ОТСЛЕЖИВАНИЕ ОТЧЕТОВ (С ЛОГАМИ)
// =======================
db.ref("reports").on("child_added", async (snap) => {
    const reportId = snap.key;
    const report = snap.val();

    console.log(`🔎 Найден отчет: ${reportId}`);

    // 1. Проверка на статус
    if (report.vkMessageId || report.status) {
        console.log(`⏭ Пропуск отчета ${reportId}: уже отправлен или проверен.`);
        return;
    }

    // 2. Проверка ID беседы
    const peerIdSnap = await db.ref("settings/chatPeerId").once("value");
    const peerId = peerIdSnap.val();

    if (!peerId) {
        console.error("⛔ ОШИБКА: Не установлен ID беседы! Напишите /bind в чате.");
        return;
    }

    console.log(`📤 Подготовка к отправке в беседу ${peerId}...`);

    // 3. Текст
    const text = `📝 НОВЫЙ ОТЧЕТ\n👤 Ник: ${report.author}\n🔰 Должность: ${report.role}\n📊 Баллы: ${report.score}\n🛠 Работа: ${report.work}`;

    // 4. Фото (с защитой от ошибок)
    const attachments = [];
    if (report.photos) {
        console.log(`📸 Загрузка фото...`);
        const photoUrls = Object.values(report.photos);
        for (const url of photoUrls) {
            try {
                const r = await fetch(url);
                if (r.ok) {
                    const buffer = Buffer.from(await r.arrayBuffer());
                    const photo = await vk.upload.messagePhoto({ source: { value: buffer }, peer_id: peerId });
                    attachments.push(photo.toString());
                }
            } catch (e) {
                console.error(`⚠ Ошибка загрузки 1 фото: ${e.message}`);
                // Не прерываем выполнение, если фото не загрузилось, отправляем текст
            }
        }
    }

    // 5. Отправка
    try {
        const keyboard = Keyboard.builder().inline()
            .callbackButton({ label: "✅ Одобрить", payload: { reportId, action: "ok" }, color: "positive" })
            .callbackButton({ label: "❌ Отказать", payload: { reportId, action: "no" }, color: "negative" });

        const msg = await vk.api.messages.send({
            peer_id: Number(peerId),
            random_id: Math.floor(Date.now() + Math.random() * 10000),
            message: text,
            attachment: attachments,
            keyboard: keyboard.toString()
        });

        // 6. Пометка в базе
        await db.ref(`reports/${reportId}`).update({ vkMessageId: msg, vkText: text, status: "pending" });
        console.log(`✅ УСПЕХ: Отчет ${reportId} отправлен в ВК!`);

    } catch (err) {
        console.error(`📛 КРИТИЧЕСКАЯ ОШИБКА VK API:`, err);
    }
});

vk.updates.start().catch(console.error);
http.createServer((_, res) => res.end("Alive")).listen(process.env.PORT || 3000);
