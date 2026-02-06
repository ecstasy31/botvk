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

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://modersekb-default-rtdb.firebaseio.com"
});

const db = admin.database();

console.log("🚀 Бот запускается...");

// =======================
// ХЕЛПЕР: ГЕНЕРАЦИЯ ID ДЛЯ ФИЛЬТРАЦИИ СТАРЫХ ОТЧЕТОВ
// =======================
// Эта функция создает ключ Firebase, соответствующий текущему времени.
// Используется, чтобы слушать только НОВЫЕ записи.
const generateMinKey = () => {
  const PUSH_CHARS = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
  const now = Date.now();
  const timeStampChars = new Array(8);
  for (let i = 7; i >= 0; i--) {
    timeStampChars[i] = PUSH_CHARS.charAt(now % 64);
    now = Math.floor(now / 64);
  }
  return timeStampChars.join("") + "0000000000000000"; // Добиваем нулями для начала отсчета
};

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

  const userReports = Object.values(reports)
    .filter(r => r.author === found.nickname);

  const lastReport = userReports.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))[0];

  const avgScore = userReports.length
    ? Math.round(
        userReports.reduce((s, r) => s + (parseInt(r.score) || 0), 0)
        / userReports.length
      )
    : 0;

  const text = `
📋 Информация о модераторе

👤 Ник: ${found.nickname}
🎖 Роль: ${found.role || "не указана"}
🟢 Статус: ${found.active ? "активен" : "неактивен"}

📊 Баллы: ${found.score || 0}
⚠️ Выговоры: ${found.warns || 0}
🚫 Пропуски: ${found.meetMiss || 0}
📝 Отчетов подано: ${userReports.length}

📅 Последний отчет: ${lastReport?.date || "нет"}
📈 Средний уровень отчета: ${avgScore}
`;

  ctx.send(text);
});

// =======================
// КНОПКИ ОДОБРИТЬ / ОТКАЗАТЬ
// =======================
vk.updates.on("message_event", async (ctx) => {
  try {
    if (!ctx.payload) return;

    // ИСПРАВЛЕНИЕ: Если payload уже объект, не парсим его. Если строка — парсим.
    const payloadData = typeof ctx.payload === 'string' 
      ? JSON.parse(ctx.payload) 
      : ctx.payload;

    const { reportId, action } = payloadData;

    const snap = await db.ref(`reports/${reportId}`).once("value");
    const report = snap.val();

    if (!report || report.status !== "pending") {
      return ctx.answer({
        type: "show_snackbar",
        text: "Этот отчет уже обработан другим администратором."
      });
    }

    const [user] = await vk.api.users.get({ user_ids: ctx.userId });
    const adminName = `${user.first_name} ${user.last_name}`;

    const approved = action === "ok";

    // ✅ Начисляем баллы только при одобрении
    if (approved) {
      const points = parseInt(report.score) || 0;
      // Ищем юзера по нику (author), чтобы начислить баллы. 
      // Примечание: лучше хранить ID, но делаем как в исходнике.
      const usersSnap = await db.ref("users").once("value");
      const users = usersSnap.val() || {};
      let userIdToUpdate = null;
      
      for(const uid in users) {
          if(users[uid].nickname === report.author) {
              userIdToUpdate = uid;
              break;
          }
      }

      if(userIdToUpdate) {
          await db.ref(`users/${userIdToUpdate}/score`).transaction(s => (s || 0) + points);
      }
    }

    await db.ref(`reports/${reportId}`).update({
      status: approved ? "approved" : "rejected",
      checker: adminName
    });

    const peerId = (await db.ref("settings/chatPeerId").once("value")).val();

    // Создаем кнопку-вердикт (она не кликабельна или просто показывает статус)
    const keyboard = Keyboard.builder()
      .inline()
      .textButton({
        label: approved ? `✅ Одобрено (${adminName})` : `❌ Отклонено (${adminName})`,
        color: approved ? "positive" : "negative",
        payload: { command: "dummy" } // пустой payload
      });

    // Редактируем сообщение: меняем текст и кнопки
    await vk.api.messages.edit({
      peer_id: peerId,
      conversation_message_id: ctx.conversationMessageId,
      message: `${report.vkText}\n\n${approved ? "✅ ОДОБРЕНО" : "❌ ОТКЛОНЕНО"}\n👤 Проверил: ${adminName}`,
      keyboard: keyboard.toString()
    });

    ctx.answer({
      type: "show_snackbar",
      text: approved ? "Вы одобрили отчет" : "Вы отклонили отчет"
    });

  } catch (e) {
    console.error("❌ Ошибка в кнопках:", e);
    // На случай ошибки пробуем хотя бы закрыть лоадер у пользователя
    try { await ctx.answer(); } catch(err) {}
  }
});

// =======================
// НОВЫЙ ОТЧЕТ → В БЕСЕДУ
// =======================

// ИСПРАВЛЕНИЕ: Слушаем только новые записи, добавленные ПОСЛЕ запуска бота
// Используем orderByKey().startAt(текущий_ключ_времени)
const startKey = generateMinKey();

db.ref("reports").orderByKey().startAt(startKey).on("child_added", async (snap) => {
  const report = snap.val();
  const reportId = snap.key;

  // Двойная защита: если отчет уже имеет vkMessageId, игнорируем (хотя startAt должен отсечь)
  if (!report || report.vkMessageId) return;

  const peerId = (await db.ref("settings/chatPeerId").once("value")).val();
  if (!peerId) {
    console.log("⚠️ Беседа не привязана (/bind)");
    return;
  }

  const text =
`📝 НОВЫЙ ОТЧЕТ

👤 Ник: ${report.nickname || report.author}
🔰 Должность: ${report.role}
📅 Дата: ${report.date}

🛠 Работа: ${report.work}
⚖️ Наказания: ${report.punishments}
📊 Баллы: ${report.score}`;

  try {
    // ======================
    // ЗАГРУЗКА ФОТО В VK
    // ======================
    let attachments = [];

    const photoList = []
      .concat(report.photos || [])
      .concat(report.photo || [])
      .filter(Boolean);

    for (const url of photoList) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        
        const arrayBuffer = await res.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // Загрузка фото в сообщение
        const photo = await vk.upload.messagePhoto({
          source: { value: buffer, filename: "report_img.jpg" }
        });

        attachments.push(photo.toString());
      } catch (e) {
        console.error(`⚠️ Не удалось загрузить фото (${url}):`, e.message);
      }
    }

    // ======================
    // КНОПКИ
    // ======================
    const keyboard = Keyboard.builder()
      .inline()
      .callbackButton({
        label: "✅ Одобрить",
        payload: { reportId, action: "ok" }, // VK-IO сам сделает JSON stringify
        color: "positive"
      })
      .callbackButton({
        label: "❌ Отказать",
        payload: { reportId, action: "no" },
        color: "negative"
      });

    // ======================
    // ОТПРАВКА
    // ======================
    const sentMessage = await vk.api.messages.send({
      peer_id: peerId,
      random_id: Date.now(),
      message: text,
      attachment: attachments.join(","),
      keyboard: keyboard.toString()
    });

    await db.ref(`reports/${reportId}`).update({
      vkMessageId: sentMessage, // vk-io возвращает ID числа
      vkText: text,
      status: "pending"
    });

    console.log(`✅ Отчет отправлен (ID: ${reportId})`);

  } catch (e) {
    console.error("❌ Ошибка при отправке отчета:", e);
  }
});

// =======================
// ЗАПУСК
// =======================
vk.updates.start()
  .then(() => console.log("✅ Polling started"))
  .catch(console.error);

http.createServer((req, res) => {
  res.end("Bot OK");
}).listen(process.env.PORT || 3000);
