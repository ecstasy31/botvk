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

console.log("🚀 Бот запускается...");

// =======================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// =======================

/**
 * Функция отправки одного отчета в ВК
 * @param {object} snapshot - Снимок данных из Firebase
 */
async function processReport(snapshot) {
    const reportId = snapshot.key;
    const report = snapshot.val();

    // 1. Проверка: Если отчет уже отправлен (есть ID сообщения ВК), пропускаем
    if (report.vkMessageId) return;
    
    // 2. Проверка: Если статус уже не pending (например, кто-то отклонил через сайт), пропускаем
    if (report.status && report.status !== "pending") return;

    try {
        console.log(`Processing report: ${reportId}`);

        const peerIdSnap = await db.ref("settings/chatPeerId").once("value");
        const peerId = peerIdSnap.val();

        if (!peerId) {
            console.error("⚠ ID беседы не установлен! Используйте /bind в беседе.");
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

        // --- ЗАГРУЗКА ФОТО ---
        const attachments = [];
        if (report.photos) {
            // Превращаем объект фото в массив URL
            const photoUrls = typeof report.photos === 'object' ? Object.values(report.photos) : [report.photos];
            console.log(`[PHOTO] Загружаю ${photoUrls.length} фото...`);

            for (const url of photoUrls) {
                try {
                    // Скачиваем фото в буфер
                    const response = await fetch(url);
                    if (!response.ok) throw new Error(`Fetch error: ${response.statusText}`);
                    const buffer = await response.buffer();

                    // Загружаем в ВК как MessagePhoto
                    const photo = await vk.upload.messagePhoto({
                        source: { value: buffer },
                        peer_id: Number(peerId)
                    });

                    attachments.push(photo.toString());
                } catch (err) {
                    console.error(`Ошибка загрузки фото (${url}):`, err.message);
                    // Не прерываем выполнение, пробуем загрузить следующие фото
                }
            }
        }

        // --- КЛАВИАТУРА ---
        const keyboard = Keyboard.builder()
            .inline()
            .callbackButton({ label: "✅ Одобрить", payload: { reportId, action: "ok" }, color: "positive" })
            .callbackButton({ label: "❌ Отказать", payload: { reportId, action: "no" }, color: "negative" })
            .toString();

        // --- ОТПРАВКА ---
        const sentMsg = await vk.api.messages.send({
            peer_id: Number(peerId),
            random_id: Math.floor(Math.random() * 2000000000),
            message: text,
            attachment: attachments, // Массив строк вида photo-123_456
            keyboard: keyboard
        });

        // --- ОБНОВЛЕНИЕ БД ---
        // Записываем ID сообщения, чтобы не отправить повторно
        await db.ref(`reports/${reportId}`).update({
            vkMessageId: sentMsg,
            vkText: text,
            status: "pending" // Убеждаемся, что статус ожидание
        });

        console.log(`✅ Отчет ${reportId} отправлен в ВК (msg: ${sentMsg})`);

    } catch (err) {
        console.error(`❌ Ошибка обработки отчета ${reportId}:`, err);
    }
}

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
        
        // Поиск пользователя (case-insensitive)
        const targetKey = Object.keys(users).find(k => k.toLowerCase() === nickRaw.toLowerCase());
        const userEntry = targetKey ? users[targetKey] : null;
        
        // Поиск отчетов пользователя
        const userReports = Object.values(reports).filter(r => (r.author || "").toLowerCase() === nickRaw.toLowerCase());

        if (!userEntry && userReports.length === 0) {
            return ctx.send(`❌ Модератор "${nickRaw}" не найден.`);
        }

        const lastReport = userReports.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))[0];
        const avgScore = userReports.length ? Math.round(userReports.reduce((s, r) => s + (Number(r.score) || 0), 0) / userReports.length) : 0;

        // Ссылка для открытия модального окна на сайте (подстрой под свой фронтенд)
        // Обычно это site.com/#profile?user=NICKNAME или site.com/?user=NICKNAME
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

        // Проверяем, существует ли отчет и актуален ли он
        if (!report || report.status !== "pending") {
            return ctx.send({ 
                message: "⚠ Этот отчет уже обработан кем-то другим.", 
                peer_id: ctx.peerId 
            });
        }

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
        
        // Редактируем сообщение, убираем кнопки
        try {
            await vk.api.messages.edit({
                peer_id: ctx.peerId,
                conversation_message_id: ctx.conversationMessageId,
                message: `${report.vkText}\n\n${statusIcon}\n👤 Проверил: ${adminName}`,
                attachment: [], // Оставляем вложения как есть или очищаем
                keyboard: Keyboard.builder().inline().toString() // Пустая клавиатура
            });
        } catch (editErr) {
            console.error("Не удалось отредактировать сообщение:", editErr);
        }

    } catch (e) { console.error("Ошибка кнопок:", e); }
});

// =======================
// МОНИТОРИНГ ОТЧЕТОВ
// =======================

// 1. Проверка "пропущенных" при старте
// Берем последние 50 отчетов и смотрим, есть ли среди них неотправленные
async function checkMissedReports() {
    console.log("🔍 Проверка пропущенных отчетов...");
    const snap = await db.ref("reports").orderByKey().limitToLast(50).once("value");
    
    if (snap.exists()) {
        const reports = snap.val();
        // Object.keys не гарантирует порядок, но Firebase ключи хронологические
        const keys = Object.keys(reports); 
        for (const key of keys) {
            const reportSnapshot = { key: key, val: () => reports[key] };
            await processReport(reportSnapshot);
        }
    }
}

// 2. Подписка на новые отчеты
// Используем limitToLast(1), чтобы не выкачивать всю базу при переподключении сокета,
// но child_added сработает на каждый новый элемент.
db.ref("reports").limitToLast(1).on("child_added", (snap) => {
    // Делаем небольшую задержку, чтобы файлы успели догрузиться на стороне клиента
    setTimeout(() => {
        processReport(snap);
    }, 2000); 
});

// =======================
// ЗАПУСК
// =======================
(async () => {
    try {
        await vk.updates.start();
        console.log('🤖 Бот мониторит ВК...');
        
        // Сразу проверяем, не пропустили ли что-то пока спали
        await checkMissedReports();
        
    } catch (e) {
        console.error('Fatal Error:', e);
    }
})();

http.createServer((_, res) => {
    res.writeHead(200);
    res.end("Bot Work");
}).listen(process.env.PORT || 3000);
