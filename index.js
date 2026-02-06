import { VK, Keyboard } from "vk-io";
import admin from "firebase-admin";
import fetch from "node-fetch";
import http from "http";

// =======================
// КОНФИГУРАЦИЯ
// =======================
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

// =======================
// ПРИВЯЗКА БЕСЕДЫ
// =======================
vk.updates.on("message_new", async (ctx) => {
  if (!ctx.text || ctx.isOutbox) return;

  if (ctx.text === "/bind") {
    await db.ref("settings/chatPeerId").set(ctx.peerId);
    return ctx.send(`✅ Беседа привязана\npeer_id: ${ctx.peerId}`);
  }

  if (ctx.text === "/id") {
    return ctx.send(`peer_id: ${ctx.peerId}`);
  }
});

// =======================
// /INFO НИК
// =======================
vk.updates.on("message_new", async (ctx) => {
  if (!ctx.text || ctx.isOutbox) return;
  if (!ctx.text.startsWith("/info")) return;

  const nick = ctx.text.split(" ").slice(1).join(" ").trim();
  if (!nick) return ctx.send("Укажи ник: /info Ник");

  const snap = await db.ref("users").once("value");
  const users = snap.val() || {};

  let found = null;
  for (const id in users) {
    if ((users[id].nickname || "").toLowerCase() === nick.toLowerCase()) {
      found = users[id];
      break;
    }
  }

  if (!found) return ctx.send("❌ Модератор не найден");

  const reportsSnap = await db.ref("reports").once("value");
  const reports = reportsSnap.val() || {};
  const userReports = Object.values(reports).filter(r => r.author === found.nickname);
  const lastReport = userReports.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))[0];

  const avgScore = userReports.length
    ? Math.round(userReports.reduce((s, r) => s + (parseInt(r.score) || 0), 0) / userReports.length)
    : 0;

  ctx.send(`
📋 Информация о модераторе
👤 Ник: ${found.nickname}
🎖 Роль: ${found.role || "не указана"}
🟢 Статус: ${found.active ? "активен" : "неактивен"}
📊 Баллы: ${found.score || 0}
📝 Отчетов: ${userReports.length}
📅 Последний: ${lastReport?.date || "нет"}
📈 Средний балл: ${avgScore}
`);
});

// =======================
// ОБРАБОТЧИК КНОПОК (ИСПРАВЛЕННЫЙ)
// =======================
vk.updates.on("message_event", async (ctx) => {
  try {
    if (!ctx.payload) return;

    // 🔥 ИСПРАВЛЕНИЕ: Проверяем тип payload перед парсингом
    const payload = typeof ctx.payload === 'string' 
      ? JSON.parse(ctx.payload) 
      : ctx.payload;

    const { reportId, action } = payload;

    if (!reportId) return;

    const snap = await db.ref(`reports/${reportId}`).once("value");
    const report = snap.val();

    if (!report || report.status !== "pending") {
      return ctx.answer({ type: "show_snackbar", text: "Уже обработано другим админом" });
    }

    const [user] = await vk.api.users.get({ user_ids: ctx.userId });
    const adminName = `${user.first_name} ${user.last_name}`;
    const approved = action === "ok";

    // Начисление баллов
    if (approved) {
      // Ищем юзера по нику
      const usersSnap = await db.ref("users").once("value");
      const users = usersSnap.val() || {};
      let userId = Object.keys(users).find(key => users[key].nickname === report.author);
      
      if (userId) {
        await db.ref(`users/${userId}/score`).transaction(s => (s || 0) + (parseInt(report.score) || 0));
      }
    }

    // Обновляем статус в БД
    await db.ref(`reports/${reportId}`).update({
      status: approved ? "approved" : "rejected",
      checker: adminName
    });

    const peerId = (await db.ref("settings/chatPeerId").once("value")).val();

    // Создаем "пустую" клавиатуру с вердиктом
    const keyboard = Keyboard.builder()
      .inline()
      .textButton({
        label: approved ? `✅ Одобрил: ${user.first_name}` : `❌ Отклонил: ${user.first_name}`,
        color: approved ? "positive" : "negative",
        payload: { command: "none" } // пустышка
      });

    // Редактируем сообщение
    await vk.api.messages.edit({
      peer_id: peerId,
      conversation_message_id: ctx.conversationMessageId,
      message: `${report.vkText}\n\n${approved ? "✅ ОДОБРЕНО" : "❌ ОТКЛОНЕНО"}\n👤 Администратор: ${adminName}`,
      keyboard: keyboard.toString()
    });

    ctx.answer({ type: "show_snackbar", text: "Готово!" });

  } catch (e) {
    console.error("❌ Ошибка кнопок:", e);
    // Пытаемся закрыть крутилку даже при ошибке
    try { await ctx.answer(); } catch(err) {}
  }
});

// =======================
// НОВЫЕ ОТЧЕТЫ (ИСПРАВЛЕНО: ТОЛЬКО НОВЫЕ)
// =======================
async function startReportListener() {
  // 1. Узнаем ID последнего существующего отчета, чтобы не слать старые
  const lastReportSnap = await db.ref("reports").orderByKey().limitToLast(1).once("value");
  const lastKey = lastReportSnap.exists() ? Object.keys(lastReportSnap.val())[0] : null;

  console.log("⏱ Последний обработанный ключ:", lastKey || "База пуста");

  // 2. Слушаем добавление, начиная с этого ключа
  let query = db.ref("reports").orderByKey();
  if (lastKey) {
    query = query.startAt(lastKey);
  }

  query.on("child_added", async (snap) => {
    const reportId = snap.key;
    const report = snap.val();

    // 🔥 Игнорируем тот самый "последний" отчет, который уже есть в базе (startAt включает его)
    if (reportId === lastKey) return; 
    
    // Если уже есть ID сообщения VK, значит отчет старый или обработанный
    if (report.vkMessageId) return;

    const peerId = (await db.ref("settings/chatPeerId").once("value")).val();
    if (!peerId) return console.log("⚠️ Беседа не привязана");

    console.log(`💡 Новый отчет найден: ${reportId}`);

    const text =
`📝 НОВЫЙ ОТЧЕТ

👤 Ник: ${report.nickname || report.author}
🔰 Должность: ${report.role}
📅 Дата: ${report.date}

🛠 Работа: ${report.work}
⚖️ Наказания: ${report.punishments}
📊 Баллы: ${report.score}`;

    // === ЗАГРУЗКА ФОТО ===
    let attachments = [];
    const photos = []
      .concat(report.photos || [])
      .concat(report.photo || [])
      .filter(Boolean); // Убираем пустые

    if (photos.length > 0) {
      console.log(`🖼 Загружаю ${photos.length} фото...`);
      for (const url of photos) {
        try {
          const res = await fetch(url);
          if (res.ok) {
            const buffer = Buffer.from(await res.arrayBuffer());
            const photo = await vk.upload.messagePhoto({
              source: { value: buffer, filename: "image.jpg" }
            });
            attachments.push(photo.toString());
          } else {
            console.log(`⚠️ Ошибка доступа к фото: ${res.status}`);
          }
        } catch (e) {
          console.error("❌ Ошибка загрузки фото:", e.message);
        }
      }
    }

    // === КНОПКИ ===
    const keyboard = Keyboard.builder()
      .inline()
      .callbackButton({
        label: "✅ Одобрить",
        payload: { reportId, action: "ok" },
        color: "positive"
      })
      .callbackButton({
        label: "❌ Отказать",
        payload: { reportId, action: "no" },
        color: "negative"
      });

    // === ОТПРАВКА ===
    try {
      const msg = await vk.api.messages.send({
        peer_id: peerId,
        random_id: Date.now(),
        message: text,
        attachment: attachments.join(","), // Прикрепляем фото
        keyboard: keyboard.toString()
      });

      // Помечаем в базе, что отправили
      await db.ref(`reports/${reportId}`).update({
        vkMessageId: msg,
        vkText: text,
        status: "pending"
      });
      
      console.log("✅ Отчет отправлен в беседу");
    } catch (e) {
      console.error("❌ Не удалось отправить сообщение в VK:", e);
    }
  });
}

// =======================
// ЗАПУСК
// =======================
startReportListener(); // Запускаем логику отчетов

vk.updates.start()
  .then(() => console.log("✅ VK Longpoll started"))
  .catch(console.error);

http.createServer((req, res) => res.end("Bot Work")).listen(process.env.PORT || 3000);
