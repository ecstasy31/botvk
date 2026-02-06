import { VK, Keyboard } from "vk-io";
import admin from "firebase-admin";
import http from "http";

const TARGET_PEER_ID = 2000000086; // Проверь, что этот ID правильный!

// Инициализация
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

// Метка времени старта, чтобы не спамить старыми отчетами при перезагрузке
// Но делаем запас побольше (1 час), на случай расхождений часов
const BOT_START_TIME = Date.now() - (60 * 60 * 1000); 

console.log("🚀 Бот запускается...");

// --- КОМАНДЫ ---
vk.updates.on('message_new', async (ctx) => {
    if (!ctx.text || ctx.isOutbox) return;
    
    if (ctx.text === '/start') {
        return ctx.send(`✅ Бот тут!\nID этого чата: ${ctx.peerId}\nЦелевой ID: ${TARGET_PEER_ID}`);
    }

    if (ctx.text === '!test') {
        return ctx.send("🟢 Тест пройден. Бот работает.");
    }
});

// --- КНОПКИ (ОДОБРИТЬ/ОТКАЗАТЬ) ---
vk.updates.on("message_event", async (ctx) => {
    try {
        const { reportId, action } = ctx.payload;
        const snap = await db.ref(`reports/${reportId}`).once("value");
        const report = snap.val();

        if (!report || report.status !== "pending") {
            return ctx.answer({ type: "show_snackbar", text: "❌ Уже обработано!" });
        }

        const [user] = await vk.api.users.get({ user_ids: ctx.userId });
        const adminName = `${user.first_name} ${user.last_name}`;
        const isOk = action === "ok";

        if (isOk) {
            // Начисляем именно столько баллов, сколько посчитал сайт (report.score)
            // Если score не указан (старый отчет), даем 1 балл по умолчанию
            const pointsToAdd = report.score || 1;
            await db.ref(`users/${report.author}/score`).transaction(s => (s || 0) + pointsToAdd);
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

// --- СЛУШАТЕЛЬ НОВЫХ ОТЧЕТОВ ---
db.ref("reports").on("child_added", async (snap) => {
    const report = snap.val();
    const reportId = snap.key;

    if (!report || report.vkMessageId) return;

    // Если у отчета вообще нет метки времени (старый) или она очень старая - игнор
    if (report.timestamp && report.timestamp < BOT_START_TIME) {
        return;
    }

    console.log(`📩 Отчет от ${report.author}. Попытка отправки...`);

    const text = `📝 НОВЫЙ ОТЧЕТ\n\n👤 Ник: ${report.nickname || report.author}\n🔰 Должность: ${report.role}\n📅 Дата: ${report.date}\n\n🛠 Работа: ${report.work}\n⚖️ Наказания: ${report.punishments}\n📊 К начислению: ${report.score} баллов`;

    try {
        const keyboard = Keyboard.builder().inline()
            .callbackButton({ label: "✅ Одобрить", payload: { reportId, action: "ok" }, color: "positive" })
            .callbackButton({ label: "❌ Отказать", payload: { reportId, action: "no" }, color: "negative" });

        const sent = await vk.api.messages.send({
            peer_id: TARGET_PEER_ID,
            random_id: Date.now(), // Обязательно для бесед
            message: text,
            keyboard
        });

        await db.ref(`reports/${reportId}`).update({
            vkMessageId: sent,
            vkText: text
        });
        
        console.log("✅ Успешно отправлено в ВК!");
    } catch (e) {
        console.error("❌ Ошибка ВК:", e.message);
    }
});

// Запуск
vk.updates.start()
    .then(() => console.log("✅ Polling started"))
    .catch(console.error);

http.createServer((req, res) => res.end("Bot OK")).listen(process.env.PORT || 3000);
