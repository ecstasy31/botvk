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

const SITE_URL = "https://ваш-сайт.com";

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
        databaseURL: "https://modersekb-default-rtdb.firebaseio.com"
    });
}

const db = admin.database();

console.log("🚀 Бот запущен и слушает базу данных...");

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

        return ctx.send({
            message: `📋 ИНФОРМАЦИЯ\n👤 Ник: ${targetKey || nickRaw}\n📧 Почта: ${userEntry?.email || "нет"}\n🎖 Роль: ${userEntry?.role || lastReport?.role || "нет"}\n🟢 Статус: ${userEntry?.active ? "активен" : "неактивен"}\n📊 Баллы: ${userEntry?.score || 0}\n📝 Отчетов: ${userReports.length}\n📅 Последний: ${lastReport?.date || "нет"}\n📈 Средний балл: ${avgScore}`,
            keyboard: Keyboard.builder().inline().urlButton({ label: "🌍 Таблица", url: SITE_URL })
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
// НОВЫЕ ОТЧЕТЫ (ИСПРАВЛЕНО)
// =======================
db.ref("reports").on("child_added", async (snap) => {
    const reportId = snap.key;
    const report = snap.val();

    console.log(`[LOG] Проверка отчета ${reportId}...`);

    // Если уже есть ID сообщения, значит отчет уже в чате
    if (report.vkMessageId) {
        console.log(`[LOG] Отчет ${reportId} уже был отправлен ранее.`);
        return;
    }

    try {
        // Даем время на подгрузку фото с сайта в базу
        await new Promise(r => setTimeout(r, 1500));
        
        // Получаем свежие данные после паузы
        const freshSnap = await db.ref(`reports/${reportId}`).once("value");
        const freshReport = freshSnap.val();

        const peerIdSnap = await db.ref("settings/chatPeerId").once("value");
        const peerId = peerIdSnap.val();

        if (!peerId) {
            console.error(`[ERR] Отчет ${reportId} не отправлен: ID беседы не установлен! (/bind в чате)`);
            return;
        }

        console.log(`[LOG] Отправляю отчет ${reportId} в беседу ${peerId}...`);

        const text = 
            `📝 НОВЫЙ ОТЧЕТ\n\n` +
            `👤 Ник: ${freshReport.author || "Не указан"}\n` +
            `🔰 Должность: ${freshReport.role || "—"}\n` +
            `📅 Дата: ${freshReport.date || "—"}\n\n` +
            `🛠 Работа: ${freshReport.work || "—"}\n` +
            `⚖️ Наказания: ${freshReport.punishments || "Нет"}\n` +
            `📊 Баллы: ${freshReport.score || 0}`;

        const attachments = [];
        if (freshReport.photos) {
            const urls = Object.values(freshReport.photos);
            for (const url of urls) {
                try {
                    const res = await fetch(url);
                    const buffer = Buffer.from(await res.arrayBuffer());
                    const photo = await vk.upload.messagePhoto({ source: { value: buffer }, peer_id: Number(peerId) });
                    attachments.push(photo.toString());
                } catch (e) { console.error("Ошибка загрузки фото:", e.message); }
            }
        }

        const keyboard = Keyboard.builder()
            .inline()
            .callbackButton({ label: "✅ Одобрить", payload: { reportId, action: "ok" }, color: "positive" })
            .callbackButton({ label: "❌ Отказать", payload: { reportId, action: "no" }, color: "negative" })
            .toString();

        const msgId = await vk.api.messages.send({
            peer_id: Number(peerId),
            random_id: Math.floor(Math.random() * 2000000000), // Правильный random_id
            message: text,
            attachment: attachments,
            keyboard: keyboard
        });

        await db.ref(`reports/${reportId}`).update({
            vkMessageId: msgId,
            vkText: text,
            status: "pending"
        });

        console.log(`✅ Отчет ${reportId} успешно отправлен!`);

    } catch (err) {
        console.error(`❌ Критическая ошибка при отправке отчета ${reportId}:`, err);
    }
});

// =======================
// ЗАПУСК
// =======================
vk.updates.start().then(() => console.log('🤖 Бот на связи (VK Polling)')).catch(console.error);

http.createServer((_, res) => {
    res.writeHead(200);
    res.end("Alive");
}).listen(process.env.PORT || 3000);
