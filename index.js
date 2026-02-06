import { VK, Keyboard } from "vk-io";
import admin from "firebase-admin";
import http from "http";

// Проверь этот ID! Он должен быть равен (2000000000 + ID беседы)
const TARGET_PEER_ID = 2000000086; 

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

console.log("🚀 Бот запускается...");

// --- КОМАНДЫ ---
vk.updates.on('message_new', async (ctx) => {
    if (!ctx.text || ctx.isOutbox) return;
    
    // Проверка, что бот вообще видит сообщения в беседе
    if (ctx.text === '/start' || ctx.text === '/id') {
        return ctx.send(`✅ Бот тут!\nID этого чата: ${ctx.peerId}\nЦелевой ID: ${TARGET_PEER_ID}`);
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
            // Начисляем баллы (автоматически при нажатии кнопки)
            // Берем report.score, который посчитал сайт (равен кол-ву наказаний)
            const pointsToAdd = parseInt(report.score) || 0;
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

    // Главная проверка: если у отчета уже есть ID сообщения ВК, значит мы его уже отправляли
    // Если нет - отправляем
    if (!report || report.vkMessageId) return;

    console.log(`📩 Отчет от ${report.author}. Попытка отправки...`);

    const text = `📝 НОВЫЙ ОТЧЕТ\n\n👤 Ник: ${report.nickname || report.author}\n🔰 Должность: ${report.role}\n📅 Дата: ${report.date}\n\n🛠 Работа: ${report.work}\n⚖️ Наказания: ${report.punishments}\n📊 К начислению: ${report.score} баллов`;

    try {
        const keyboard = Keyboard.builder().inline()
            .callbackButton({ label: "✅ Одобрить", payload: { reportId, action: "ok" }, color: "positive" })
            .callbackButton({ label: "❌ Отказать", payload: { reportId, action: "no" }, color: "negative" });

        const sent = await vk.api.messages.send({
            peer_id: TARGET_PEER_ID,
            random_id: Date.now(), // Обязательный параметр для бесед
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

// Запуск бота
vk.updates.start()
    .then(() => console.log("✅ Polling started"))
    .catch(console.error);

http.createServer((req, res) => res.end("Bot OK")).listen(process.env.PORT || 3000);
