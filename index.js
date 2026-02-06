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
let isBotReady = false; // Флаг для игнорирования старых отчетов при старте

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

        return ctx.send({
            message: `📋 ИНФОРМАЦИЯ\n👤 Ник: ${targetKey || nickRaw}\n📧 Почта: ${userEntry?.email || "нет"}\n🎖 Роль: ${userEntry?.role || lastReport?.role || "нет"}\n🟢 Статус: ${userEntry?.active ? "активен" : "неактивен"}\n📊 Баллы: ${userEntry?.score || 0}\n📝 Отчетов: ${userReports.length}\n📅 Последний: ${lastReport?.date || "нет"}\n📈 Средний балл: ${avgScore}`,
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
// НОВЫЕ ОТЧЕТЫ (ФИКС ПЕРЕЗАГРУЗКИ И ФОТО)
// =======================

// 1. Сначала помечаем, что бот загрузил текущую базу
db.ref("reports").once("value", () => {
    isBotReady = true;
    console.log("✅ База данных синхронизирована. Бот готов принимать НОВЫЕ отчеты.");
});

// 2. Слушаем добавление новых записей
db.ref("reports").on("child_added", async (snap) => {
    // Если бот еще не загрузил старые данные, игнорируем их
    if (!isBotReady) return;

    const reportId = snap.key;
    const report = snap.val();

    // На всякий случай проверяем, не отправляли ли мы его уже
    if (report.vkMessageId) return;

    try {
        // Пауза, чтобы данные (особенно фото) точно успели прописаться в Firebase
        await new Promise(r => setTimeout(r, 2000));
        
        const freshSnap = await db.ref(`reports/${reportId}`).once("value");
        const freshReport = freshSnap.val();

        const peerIdSnap = await db.ref("settings/chatPeerId").once("value");
        const peerId = peerIdSnap.val();

        if (!peerId) {
            console.error("⚠ ID беседы не установлен!");
            return;
        }

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
        if (freshReport.photos) {
            const urls = Object.values(freshReport.photos);
            console.log(`[PHOTO] Найдено ${urls.length} фото для отчета ${reportId}. Загружаю...`);
            
            for (const url of urls) {
                try {
                    const res = await fetch(url);
                    if (!res.ok) continue;
                    
                    const buffer = await res.buffer(); // Скачиваем файл в память
                    
                    // Загружаем в ВК именно как файл (photo)
                    const photo = await vk.upload.messagePhoto({
                        source: { value: buffer },
                        peer_id: Number(peerId)
                    });
                    
                    attachments.push(photo.toString());
                } catch (e) {
                    console.error("Ошибка при загрузке картинки в ВК:", e.message);
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
            random_id: Math.floor(Math.random() * 2000000000),
            message: text,
            attachment: attachments, // Теперь тут массив загруженных фото-объектов
            keyboard: keyboard
        });

        await db.ref(`reports/${reportId}`).update({
            vkMessageId: msgId,
            vkText: text,
            status: "pending"
        });

        console.log(`✅ Отчет ${reportId} успешно отправлен с ${attachments.length} фото.`);

    } catch (err) {
        console.error(`❌ Ошибка обработки отчета ${reportId}:`, err);
    }
});

// =======================
// ЗАПУСК
// =======================
vk.updates.start().then(() => console.log('🤖 Бот мониторит ВК...')).catch(console.error);

http.createServer((_, res) => {
    res.writeHead(200);
    res.end("Bot Work");
}).listen(process.env.PORT || 3000);
