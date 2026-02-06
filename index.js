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

const SITE_URL = "https://ваш-сайт.com"; // ТВОЙ САЙТ

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
        databaseURL: "https://modersekb-default-rtdb.firebaseio.com"
    });
}

const db = admin.database();
const startTime = Date.now(); // Время запуска бота

console.log("🚀 Бот запущен. Ожидание новых отчетов...");

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

    if (text === "/id") return ctx.send(`peer_id: ${ctx.peerId}`);

    if (text.toLowerCase().startsWith("/info")) {
        const nickRaw = text.replace(/^\/info\s*/i, "").trim();
        if (!nickRaw) return ctx.send("❗ Используй: /info Ник");

        const [uSnap, rSnap] = await Promise.all([db.ref("users").once("value"), db.ref("reports").once("value")]);
        const users = uSnap.val() || {};
        const reports = rSnap.val() || {};
        
        const targetKey = Object.keys(users).find(k => k.toLowerCase() === nickRaw.toLowerCase());
        const userEntry = targetKey ? users[targetKey] : null;
        const userReports = Object.values(reports).filter(r => (r.author || "").toLowerCase() === nickRaw.toLowerCase());

        if (!userEntry && userReports.length === 0) return ctx.send(`❌ Модератор "${nickRaw}" не найден.`);

        const lastReport = userReports.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))[0];
        const avgScore = userReports.length ? Math.round(userReports.reduce((s, r) => s + (Number(r.score) || 0), 0) / userReports.length) : 0;

        return ctx.send({
            message: `📋 ИНФОРМАЦИЯ\n👤 Ник: ${targetKey || nickRaw}\n📊 Баллы: ${userEntry?.score || 0}\n📝 Отчетов: ${userReports.length}\n📈 Средний балл: ${avgScore}`,
            keyboard: Keyboard.builder().inline().urlButton({ 
                label: "🌍 Профиль в таблице", 
                url: `${SITE_URL}/#profile?user=${encodeURIComponent(targetKey || nickRaw)}` 
            })
        });
    }
});

// =======================
// ЛОГИКА ОБРАБОТКИ ФОТО
// =======================
async function getBuffer(data) {
    try {
        if (data.startsWith('data:image')) {
            // Очистка Base64 от префиксов браузера
            const base64Image = data.split(';base64,').pop();
            return Buffer.from(base64Image, 'base64');
        } else {
            // Обычная ссылка
            const response = await fetch(data);
            if (!response.ok) return null;
            // Совместимость с разными версиями node-fetch
            const arrayBuffer = await response.arrayBuffer();
            return Buffer.from(arrayBuffer);
        }
    } catch (e) {
        console.error("Ошибка буферизации фото:", e.message);
        return null;
    }
}

// =======================
// ОБРАБОТКА НОВЫХ ОТЧЕТОВ
// =======================
db.ref("reports").on("child_added", async (snap) => {
    const reportId = snap.key;
    const report = snap.val();

    // 1. Игнорируем старые отчеты, которые уже были до запуска бота
    // 2. Игнорируем, если уже отправлено
    if (report.vkMessageId || (report.timestamp && report.timestamp < startTime)) return;

    // --- ФИКС ДУБЛИРОВАНИЯ (ТРАНЗАКЦИЯ) ---
    const lockRef = db.ref(`reports/${reportId}/processing`);
    const { committed } = await lockRef.transaction((current) => {
        if (current === true) return undefined; // Отмена, если уже кто-то обрабатывает
        return true;
    });

    if (!committed) return; // Выходим, если этот отчет уже "взят" в работу

    try {
        // Ждем чуть-чуть для подгрузки данных
        await new Promise(r => setTimeout(r, 2500));
        
        const freshSnap = await db.ref(`reports/${reportId}`).once("value");
        const r = freshSnap.val();
        
        const peerIdSnap = await db.ref("settings/chatPeerId").once("value");
        const peerId = peerIdSnap.val();
        if (!peerId) return;

        const text = `📝 НОВЫЙ ОТЧЕТ\n\n👤 Ник: ${r.author}\n🔰 Роль: ${r.role}\n📅 Дата: ${r.date}\n🛠 Работа: ${r.work}\n📊 Баллы: ${r.score}`;

        // --- ЗАГРУЗКА ФОТО ---
        const attachments = [];
        if (r.photos) {
            const photoList = Object.values(r.photos);
            for (const pData of photoList) {
                const buffer = await getBuffer(pData);
                if (buffer) {
                    try {
                        const photo = await vk.upload.messagePhoto({
                            source: { value: buffer },
                            peer_id: Number(peerId)
                        });
                        attachments.push(photo.toString());
                    } catch (uploadErr) {
                        console.error("VK Upload Error:", uploadErr.message);
                    }
                }
            }
        }

        const keyboard = Keyboard.builder()
            .inline()
            .callbackButton({ label: "✅ Одобрить", payload: { reportId, action: "ok" }, color: "positive" })
            .callbackButton({ label: "❌ Отказать", payload: { reportId, action: "no" }, color: "negative" })
            .toString();

        const msgId = await vk.api.messages.send({
            peer_id: Number(peerId),
            random_id: 0,
            message: text,
            attachment: attachments,
            keyboard: keyboard
        });

        // Записываем финал
        await db.ref(`reports/${reportId}`).update({
            vkMessageId: msgId,
            vkText: text,
            status: "pending",
            processing: false // Освобождаем
        });

        console.log(`✅ Отчет ${reportId} отправлен.`);

    } catch (err) {
        console.error("Ошибка отправки:", err);
        await db.ref(`reports/${reportId}`).update({ processing: false });
    }
});

// =======================
// КНОПКИ ОДОБРЕНИЯ (ФИНАЛ)
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

        const isApproved = action === "ok";
        const [adm] = await vk.api.users.get({ user_ids: ctx.userId });
        const adminName = `${adm.first_name} ${adm.last_name}`;

        if (isApproved && report.author) {
            await db.ref(`users/${report.author}/score`).transaction(c => (c || 0) + (Number(report.score) || 0));
        }

        await reportRef.update({
            status: isApproved ? "approved" : "rejected",
            checker: adminName
        });

        await vk.api.messages.edit({
            peer_id: ctx.peerId,
            conversation_message_id: ctx.conversationMessageId,
            message: `${report.vkText}\n\n${isApproved ? "✅ ОДОБРЕНО" : "❌ ОТКЛОНЕНО"}\n👤 Проверил: ${adminName}`,
            keyboard: Keyboard.builder().inline().toString()
        });
    } catch (e) { console.error(e); }
});

vk.updates.start().catch(console.error);

http.createServer((_, res) => { res.end("Alive"); }).listen(process.env.PORT || 3000);
