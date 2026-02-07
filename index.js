// =======================
// 1️⃣ УВЕДОМЛЕНИЕ О ПОКУПКЕ В МАГАЗИНЕ
// =======================

let processedPurchases = new Set();

// Инициализация: загружаем уже обработанные покупки при запуске
async function initializePurchases() {
    try {
        const purchasesSnap = await db.ref("shop_purchases").once("value");
        const purchases = purchasesSnap.val() || {};
        
        Object.keys(purchases).forEach(id => {
            if (purchases[id].vkNotified) {
                processedPurchases.add(id);
            }
        });
        
        console.log(`[SHOP] Загружено обработанных покупок: ${processedPurchases.size}`);
    } catch (error) {
        console.error("[SHOP] Ошибка загрузки покупок:", error);
    }
}

// Обработчик новых покупок
db.ref("shop_purchases").on("child_added", async (snap) => {
    if (!isBotReady) return;
    
    const purchaseId = snap.key;
    const purchase = snap.val();
    
    // Защита от дубликатов
    if (processedPurchases.has(purchaseId) || purchase.vkNotified) {
        console.log(`[SHOP] Покупка ${purchaseId} уже обработана, пропускаем`);
        return;
    }
    
    console.log(`[SHOP] Обрабатываю новую покупку: ${purchaseId}`);
    await processNewPurchase(purchaseId, purchase);
});

async function processNewPurchase(purchaseId, purchase) {
    try {
        // Получаем ID беседы из настроек
        const peerIdSnap = await db.ref("settings/chatPeerId").once("value");
        const peerId = peerIdSnap.val();
        
        if (!peerId) {
            console.error(`[SHOP] Беседа не привязана! Используйте /bind в нужной беседе.`);
            return;
        }
        
        // Форматируем время
        const time = purchase.timestamp 
            ? new Date(purchase.timestamp).toLocaleString("ru-RU", {
                hour: "2-digit",
                minute: "2-digit",
                day: "2-digit",
                month: "2-digit",
                year: "numeric"
            })
            : new Date().toLocaleString("ru-RU");
        
        // Форматируем сообщение с эмодзи
        const message = 
            `🛒 ПОКУПКА В МАГАЗИНЕ\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `👤 Модератор: [id713635121|${purchase.user || "Неизвестно"}]\n` +
            `📦 Товар: ${purchase.item || "Неизвестно"}\n` +
            `💰 Цена: ${purchase.price || 0} баллов\n` +
            `🕐 Время: ${time}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `✅ Покупка зафиксирована в системе`;
        
        // Отправляем сообщение в беседу
        await vk.api.messages.send({
            peer_id: Number(peerId),
            random_id: Math.floor(Math.random() * 2000000000),
            message: message
        });
        
        console.log(`✅ Уведомление о покупке ${purchaseId} отправлено`);
        
        // Помечаем как обработанную
        await db.ref(`shop_purchases/${purchaseId}`).update({
            vkNotified: true,
            vkNotificationTime: Date.now()
        });
        
        processedPurchases.add(purchaseId);
        
    } catch (error) {
        console.error(`❌ Ошибка обработки покупки ${purchaseId}:`, error);
    }
}

// =======================
// 2️⃣ АВТО-ОЦЕНКА ОТЧЁТА (ТОЛЬКО ОТЗЫВ)
// =======================

let processedReviews = new Set();

// Инициализация: загружаем уже обработанные отзывы
async function initializeReviews() {
    try {
        const reportsSnap = await db.ref("reports").once("value");
        const reports = reportsSnap.val() || {};
        
        Object.keys(reports).forEach(id => {
            if (reports[id].autoReviewSent) {
                processedReviews.add(id);
            }
        });
        
        console.log(`[REVIEW] Загружено авто-оценок: ${processedReviews.size}`);
    } catch (error) {
        console.error("[REVIEW] Ошибка загрузки отзывов:", error);
    }
}

// Обработчик новых отчетов для авто-оценки
db.ref("reports").on("child_added", async (snap) => {
    if (!isBotReady) return;
    
    const reportId = snap.key;
    const report = snap.val();
    
    // Игнорируем старые отчеты (без timestamp) и уже обработанные
    if (!report.timestamp || processedReviews.has(reportId) || report.autoReviewSent) {
        return;
    }
    
    // Проверяем, что отчет не старше 1 часа (чтобы не реагировать на старые)
    const reportAge = Date.now() - report.timestamp;
    if (reportAge > 3600000) { // 1 час в миллисекундах
        console.log(`[REVIEW] Отчет ${reportId} старше 1 часа, пропускаем`);
        return;
    }
    
    console.log(`[REVIEW] Анализирую отчет ${reportId} для авто-оценки`);
    await sendAutoReview(reportId, report);
});

async function sendAutoReview(reportId, report) {
    try {
        // Получаем ID беседы
        const peerIdSnap = await db.ref("settings/chatPeerId").once("value");
        const peerId = peerIdSnap.val();
        
        if (!peerId) {
            console.error(`[REVIEW] Беседа не привязана!`);
            return;
        }
        
        // Анализ отчета
        const remarks = [];
        
        // Проверка длины текста
        if (!report.work || report.work.trim().length < 50) {
            remarks.push("— Мало описания работы (менее 50 символов)");
        }
        
        // Проверка наличия фото
        if (!report.imgs || !Array.isArray(report.imgs) || report.imgs.length === 0) {
            remarks.push("— Нет прикрепленных доказательств (фото)");
        }
        
        // Проверка на подозрительно высокий балл при малом количестве фото
        const score = Number(report.score) || 0;
        const photoCount = Array.isArray(report.imgs) ? report.imgs.length : 0;
        
        if (score > 8 && photoCount < 2) {
            remarks.push("— Высокий балл при недостаточном количестве доказательств");
        }
        
        // Формируем отзыв
        let reviewMessage = "🧠 АВТО-АНАЛИЗ ОТЧЁТА\n";
        reviewMessage += "━━━━━━━━━━━━━━━━━━\n";
        reviewMessage += `👤 Ник: ${report.author || "Неизвестно"}\n`;
        reviewMessage += `📊 Баллы: ${score}\n`;
        reviewMessage += `📎 Фото: ${photoCount} шт.\n`;
        
        if (remarks.length > 0) {
            reviewMessage += "\n⚠️ Замечания:\n";
            reviewMessage += remarks.join("\n");
        } else {
            reviewMessage += "\n✅ Отчёт выглядит качественно и соответствует стандартам";
        }
        
        reviewMessage += "\n━━━━━━━━━━━━━━━━━━\n";
        reviewMessage += "ℹ️ Это автоматический анализ. Окончательное решение — за проверяющим.";
        
        // Отправляем отзыв ОТ ИМЕНИ БОТА отдельным сообщением
        await vk.api.messages.send({
            peer_id: Number(peerId),
            random_id: Math.floor(Math.random() * 2000000000),
            message: reviewMessage
        });
        
        console.log(`✅ Авто-оценка для отчета ${reportId} отправлена`);
        
        // Помечаем как обработанную
        await db.ref(`reports/${reportId}`).update({
            autoReviewSent: true,
            autoReviewTime: Date.now(),
            autoRemarks: remarks
        });
        
        processedReviews.add(reportId);
        
    } catch (error) {
        console.error(`❌ Ошибка отправки авто-оценки для отчета ${reportId}:`, error);
    }
}

// =======================
// ОБНОВЛЕНИЕ ИНИЦИАЛИЗАЦИИ
// =======================

async function initializeExistingData() {
    console.log("[INIT] Загружаю существующие данные...");
    
    const usersSnap = await db.ref("users").once("value");
    const users = usersSnap.val() || {};
    existingUsers = new Set(Object.keys(users));
    console.log(`[INIT] Загружено пользователей: ${existingUsers.size}`);
    
    const reportsSnap = await db.ref("reports").once("value");
    const reports = reportsSnap.val() || {};
    existingReports = new Set(Object.keys(reports));
    console.log(`[INIT] Загружено отчетов: ${existingReports.size}`);
    
    // Инициализируем системы покупок и авто-оценок
    await initializePurchases();
    await initializeReviews();
    
    isBotReady = true;
    console.log("[INIT] Бот готов к работе!");
}

// =======================
// ДОПОЛНИТЕЛЬНЫЕ КОМАНДЫ
// =======================

vk.updates.on("message_new", async (ctx) => {
    if (ctx.isOutbox || !ctx.text) return;
    const text = ctx.text.trim();
    
    // ... существующие команды ...
    
    // Новая команда для проверки работы модулей
    if (text === "/check_modules") {
        const modulesStatus = 
            `🔧 СТАТУС МОДУЛЕЙ\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `🛒 Магазин: ${processedPurchases.size} обработанных покупок\n` +
            `🧠 Авто-оценка: ${processedReviews.size} отправленных отзывов\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `✅ Модули активны и готовы к работе`;
        
        return ctx.send(modulesStatus);
    }
});

// =======================
// ЗАПУСК С ДОБАВЛЕННЫМИ МОДУЛЯМИ
// =======================

async function startBot() {
    try {
        await initializeExistingData();
        await vk.updates.start();
        
        console.log('🤖 Бот успешно запущен');
        console.log('🛒 Модуль покупок: АКТИВЕН');
        console.log('🧠 Модуль авто-оценки: АКТИВЕН');
        console.log('📊 Команды: /bind, /id, /info [ник], /check_modules');
        
    } catch (error) {
        console.error('❌ Ошибка запуска:', error);
    }
}

startBot();
