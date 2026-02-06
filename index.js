import { VK, Keyboard } from "vk-io";
import admin from "firebase-admin";
import http from "http";

const TARGET_PEER_ID = 2000000086;
// Добавляем запас в 5 минут, чтобы не игнорировать новые отчеты из-за разницы времени
const BOT_START_TIME = Date.now() - (5 * 60 * 1000); 

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

console.log("🚀 Бот запущен. Ожидание отчетов...");

// --- КОМАНДЫ ---
vk.updates.on('message_new', async (ctx) => {
    if (!ctx.text || ctx.isOutbox) return;
    const text = ctx.text.trim();
    const args = text.split(' ');
    const command = args[0].toLowerCase();

    if (command === '/start') {
        return ctx.send(`✅ Бот активен!\n🆔 ID чата: ${ctx.peerId}\n🎯 Цель: ${TARGET_PEER_ID}`);
    }

    if (command === '!test') {
        return ctx.send("🟢 Проверка связи: ОК. Бот видит сообщения.");
    }

    if (command === '/info') {
        const nick = args.slice(1).join(' ');
        if (!nick) return ctx.send("❌ Напиши: /info Ник");

        const snap = await db.ref(`users/${nick}`).once('value');
        const user = snap.val();

        if (!user) return ctx.send(`👤 Юзер ${nick} не найден в БД.`);

        return ctx.send(
            `📊 Статистика: ${nick}\n` +
            `🔹 Баллы: ${user.score || 0}\n` +
            `🔹 Роль: ${user.role || 'Нет'}\n` +
            `🔹 Выговоры: ${user.warns || 0}`
        );
    }
});

// --- ОБРАБОТКА КНОПОК ---
vk.updates.on("message_event", async (ctx) => {
    try {
        const { reportId, action } = ctx.payload;
        const snap = await db.ref(`reports/${reportId}`).once("value");
        const report = snap.val();

        if (!report || report.status !== "pending") {
            return ctx.answer({ type: "show_snackbar", text: "❌ Уже проверено!" });
        }

        const [user] = await vk.api.users.get({ user_ids: ctx.userId });
        const adminName = `${user.first_name} ${user.last_name}`;
        const isOk = action === "ok";

        if (isOk) {
            await db.ref(`users/${report.author}/score`).transaction(s => (s || 0) + (report.score || 10));
        }

        await db.ref(`reports/${reportId}`).update({
            status: isOk ? "approved" : "rejected",
            checker: adminName
        });

        await vk.api.messages.edit({
            peer_id: TARGET_PEER_ID,
            conversation_message_id: ctx.conversationMessageId,
            message: `${report.vkText}\n\n${isOk ? '✅ ОДОБРЕНО' : '❌ ОТКЛОНЕНО'}\n👤 Проверил: ${adminName}`,
            keyboard: Keyboard.builder()
        });

        return ctx.answer({ type: "show_snackbar", text: isOk ? "Принято!" : "Отказано" });
    } catch (e) {
        console.error("Ошибка кнопок:", e);
    }
});

// --- ЛИСТЕНЕР ОТЧЕТОВ ---
db.ref("reports").on("child_added", async (snap) => {
    const report = snap.val();
    const reportId = snap.key;

    if (!report || report.vkMessageId) return;

    // Проверка времени
    if (!report.timestamp || report.timestamp < BOT_START_TIME) {
        console.log(`[Игнор] Старый отчет от ${report.author}`);
        return;
    }

    console.log(`📩 Получен новый отчет от ${report.author}. Отправляю в ВК...`);

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

        await db.ref(`reports/${reportId}`).update({
            vkMessageId: sent,
            vkText: text
        });
        
        console.log("✅ Отчет успешно отправлен в чат!");
    } catch (e) {
        console.error("❌ Ошибка отправки в ВК:", e.message);
    }
});

http.createServer((req, res) => res.end("OK")).listen(process.env.PORT || 3000);
