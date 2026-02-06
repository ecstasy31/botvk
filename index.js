import { VK, Keyboard } from "vk-io";
import admin from "firebase-admin";
import http from "http";

const TARGET_PEER_ID = 2000000086;
const BOT_START_TIME = Date.now(); 

const vk = new VK({
  token: process.env.VK_TOKEN,
  apiVersion: "5.199",
  pollingGroupId: Number(process.env.VK_GROUP_ID)
});

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://modersekb-default-rtdb.firebaseio.com"
});
const db = admin.database();

console.log("🚀 БОТ ЗАПУЩЕН. СЛУШАЮ ОТЧЕТЫ...");

// --- КОМАНДЫ (СТАРТ, ИНФО, ТЕСТ) ---
vk.updates.on('message_new', async (ctx) => {
    if (!ctx.text || ctx.isOutbox) return;
    const text = ctx.text.trim();
    const args = text.split(' ');
    const cmd = args[0].toLowerCase();

    if (cmd === '/start') {
        return ctx.send(`✅ Бот онлайн!\n🆔 Чат ID: ${ctx.peerId}\n🎯 Цель: ${TARGET_PEER_ID}`);
    }
    if (cmd === '!test') {
        return ctx.send("🟢 Я вижу сообщения. Жду отчеты с сайта.");
    }
    if (cmd === '/info') {
        const nick = args.slice(1).join(' ');
        if (!nick) return ctx.send("❌ Напиши: /info Ник_Нейм");
        const snap = await db.ref(`users/${nick}`).once('value');
        const user = snap.val();
        if (!user) return ctx.send(`👤 Юзер ${nick} не найден.`);
        return ctx.send(`📊 ${nick}:\n💰 Баллы: ${user.score || 0}\n🔰 Роль: ${user.role || 'Нет'}\n⚠️ Выговоры: ${user.warns || 0}`);
    }
});

// --- ОБРАБОТКА КНОПОК ---
vk.updates.on("message_event", async (ctx) => {
    const { reportId, action } = ctx.payload;
    const snap = await db.ref(`reports/${reportId}`).once("value");
    const report = snap.val();

    if (!report || report.status !== "pending") return ctx.answer({ type: "show_snackbar", text: "❌ Обработано!" });

    const [u] = await vk.api.users.get({ user_ids: ctx.userId });
    const adminName = `${u.first_name} ${u.last_name}`;
    const isOk = action === "ok";

    if (isOk) {
        // Начисляем баллы юзеру
        await db.ref(`users/${report.author}/score`).transaction(s => (s || 0) + (report.score || 10));
    }

    await db.ref(`reports/${reportId}`).update({ status: isOk ? "approved" : "rejected", checker: adminName });

    await vk.api.messages.edit({
        peer_id: TARGET_PEER_ID,
        conversation_message_id: ctx.conversationMessageId,
        message: `${report.vkText}\n\n${isOk ? '✅ ОДОБРЕНО' : '❌ ОТКЛОНЕНО'}\n👤 Проверил: ${adminName}`,
        keyboard: Keyboard.builder()
    });
    ctx.answer({ type: "show_snackbar", text: isOk ? "Одобрено" : "Отказано" });
});

// --- ГЛАВНЫЙ СЛУШАТЕЛЬ ОТЧЕТОВ ---
db.ref("reports").on("child_added", async (snap) => {
    const report = snap.val();
    const reportId = snap.key;

    if (!report) return;

    // 1. Проверка: не отправляли ли уже?
    if (report.vkMessageId) return;

    // 2. Проверка времени (отсекаем старые)
    if (!report.timestamp || report.timestamp < BOT_START_TIME) {
        console.log(`[ИГНОР] Старый отчет от ${report.author}`);
        return;
    }

    console.log(`[НОВЫЙ] Отчет от ${report.author}. Отправляю в ВК...`);

    const text = `📝 НОВЫЙ ОТЧЕТ\n\n👤 Ник: ${report.nickname}\n🔰 Должность: ${report.role}\n📅 Дата: ${report.date}\n\n🛠 Работа: ${report.work}\n⚖️ Наказания: ${report.punishments}\n📊 Баллы: ${report.score}`;

    try {
        const keyboard = Keyboard.builder().inline()
            .callbackButton({ label: "✅ Одобрить", payload: { reportId, action: "ok" }, color: "positive" })
            .callbackButton({ label: "❌ Отказать", payload: { reportId, action: "no" }, color: "negative" });

        const sent = await vk.api.messages.send({
            peer_id: TARGET_PEER_ID,
            random_id: Date.now(),
            message: text,
            keyboard
        });

        // Сохраняем в базу, что отправили
        await db.ref(`reports/${reportId}`).update({
            vkMessageId: sent,
            vkText: text
        });
        console.log(`✅ ОТПРАВЛЕНО! ID сообщения: ${sent}`);

    } catch (e) {
        console.error("❌ ОШИБКА ОТПРАВКИ:", e.message);
    }
});

http.createServer((q, r) => r.end("OK")).listen(process.env.PORT || 3000);
