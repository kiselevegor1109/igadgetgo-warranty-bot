import express from "express";
import { Bot, InputFile } from "grammy";
import { PDFDocument, rgb } from "pdf-lib";
import dayjs from "dayjs";
import fs from "fs/promises";
import path from "path";
import url from "url";

// ----------------- Конфигурация -----------------
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const MANAGER_USERNAMES = (process.env.MANAGER_USERNAMES || "")
  .split(",")
  .map(s => s.trim().replace(/^@/, ""))
  .filter(Boolean);
const BRAND_NAME = process.env.BRAND_NAME || "iGadGetGo";
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "info@igadgetgo.ru";
const TZ = process.env.TIMEZONE || "Europe/Moscow"; // инфо-переменная

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN");
  process.exit(1);
}

// ----------------- Web + Bot -----------------
const app = express();
app.get("/", (_, res) => res.send("OK igadgetgo warranty bot"));

const bot = new Bot(BOT_TOKEN);

// Память: у кого ждём IMEI и какие данные заказа
// chatId -> { product, qty, price, orderId }
const chatIdToPending = new Map();

function isManager(ctx) {
  const u = ctx.from?.username || "";
  const ok = MANAGER_USERNAMES.includes(u);
  if (!ok) console.log(`Blocked user @${u} chat=${ctx.chat?.id}`);
  return ok;
}

bot.command("start", async (ctx) => {
  if (!isManager(ctx)) return;
  await ctx.reply(
    "Перешлите сюда уведомление о заказе из конструктора.\n" +
    "Я извлеку товар, количество и цену, затем попрошу IMEI и пришлю PDF.\n\n" +
    "Подсказка: IMEI можно вводить с пробелами — я оставлю только цифры."
  );
});

bot.on("message:text", async (ctx) => {
  try {
    if (!isManager(ctx)) return;

    const pending = chatIdToPending.get(ctx.chat.id);
    const text = (ctx.message.text || "").trim();

    // Если ждём IMEI — принимаем любые символы, вытаскиваем только цифры
    if (pending) {
      const imeiDigits = text.replace(/\D+/g, ""); // оставить только цифры
      if (imeiDigits.length < 8 || imeiDigits.length > 20) {
        await ctx.reply("IMEI должен содержать от 8 до 20 цифр. Отправьте ещё раз.");
        return;
      }

      chatIdToPending.delete(ctx.chat.id);

      try {
        const pdf = await makePdf({
          brand: BRAND_NAME,
          email: SUPPORT_EMAIL,
          date: dayjs().format("DD.MM.YYYY"),
          product: pending.product,
          qty: pending.qty,
          price: pending.price,
          orderId: pending.orderId || "manual",
          imei: imeiDigits
        });

        await ctx.replyWithDocument(
          new InputFile(pdf, `warranty_${pending.orderId || "manual"}.pdf`)
        );
      } catch (err) {
        console.error("PDF generation error:", err);
        await ctx.reply("Не удалось сформировать PDF. Проверьте файлы в assets/ (logo, stamp, signature в PNG/JPG) и пришлите логи.");
      }
      return;
    }

    // Пытаемся распарсить пересланный текст заказа
    const parsed = parseOrder(text);
    if (!parsed) {
      await ctx.reply(
        "Не смог распознать заказ. Перешлите сообщение как в уведомлении конструктора.\n" +
        "Пример нужных строк:\n" +
        "— Новый заказ №3\n" +
        "— Строка с товаром и количеством: ... x 1 шт.\n" +
        "— Общая стоимость заказа: 100 300 ₽"
      );
      return;
    }

    chatIdToPending.set(ctx.chat.id, parsed);
    await ctx.reply(
      `Заказ принят:\n` +
      `Товар: ${parsed.product}\n` +
      `Кол-во: ${parsed.qty}\n` +
      `Цена: ${parsed.price.toLocaleString("ru-RU")} ₽\n\n` +
      `Введите IMEI (можно с пробелами — я оставлю только цифры).`
    );
  } catch (e) {
    console.error("Handler error:", e);
    try { await ctx.reply("Произошла ошибка. Пришлите текст заказа ещё раз или IMEI повторно."); } catch {}
  }
});

// ----------------- Парсер уведомления -----------------
function parseOrder(raw) {
  // Минимум ожидаем:
  // "Новый заказ №<id>"
  // строку с "x <число> шт." — в ней берём товар и qty
  // "Общая стоимость заказа: <цена> ₽"
  const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);

  const orderLine = lines.find(l => /^Новый заказ №/i.test(l));
  const orderId = orderLine?.match(/№\s*([A-Za-z0-9_-]+)/)?.[1];

  // Первая строка с шаблоном "x N шт."
  const productLine = lines.find(l => /x\s*\d+\s*шт\.?/i.test(l)) || "";
  const qty = Number(productLine.match(/x\s*(\d+)\s*шт/i)?.[1] || "1");
  const product = productLine.replace(/\s*x\s*\d+\s*шт\.?/i, "").trim();

  // Цена
  const priceLine = lines.find(l => /^Общая стоимость заказа:/i.test(l)) || "";
  const priceDigits = (priceLine.match(/([\d\s]+)\s*₽/)?.[1] || "").replace(/\s+/g, "");
  const price = Number(priceDigits || "0");

  if (!product || !qty || !price) {
    console.log("Parse failed:", { product, qty, price, sample: raw.slice(0, 200) });
    return null;
  }
  return { product, qty, price, orderId };
}

// ----------------- Загрузка и вставка изображений (PNG/JPG) -----------------
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

async function loadImageBuffer(relBase) {
  const candidates = [`${relBase}.png`, `${relBase}.jpg`, `${relBase}.jpeg`];
  for (const name of candidates) {
    try {
      const buf = await fs.readFile(path.join(__dirname, "assets", name));
      return { buf, ext: path.extname(name).toLowerCase() };
    } catch {}
  }
  console.warn(`Image not found: ${relBase} (png/jpg/jpeg)`);
  return null;
}

async function embedImageAuto(pdfDoc, image) {
  if (!image) return null;
  const { buf, ext } = image;
  try {
    if (ext === ".png") return await pdfDoc.embedPng(buf);
    return await pdfDoc.embedJpg(buf); // jpg/jpeg
  } catch (e) {
    console.error("Embed image error:", e);
    return null;
  }
}

// ----------------- PDF генерация -----------------
async function makePdf({ brand, email, date, product, qty, price, orderId, imei }) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]); // A4
  const { width } = page.getSize();

  const logo = await embedImageAuto(pdfDoc, await loadImageBuffer("logo"));
  const stamp = await embedImageAuto(pdfDoc, await loadImageBuffer("stamp"));
  const sign  = await embedImageAuto(pdfDoc, await loadImageBuffer("signature"));

  let y = 790;

  // Лого
  if (logo) {
    const w = 120;
    const scale = w / logo.width;
    const h = logo.height * scale;
    page.drawImage(logo, { x: 40, y: y - h, width: w, height: h });
  }

  page.drawText(`Гарантийный документ № W-${orderId || "manual"}-${dayjs().format("YYMMDD")}`, {
    x: 40, y: y - 30, size: 14
  });
  page.drawText(`Дата: ${date}`, { x: 40, y: y - 50, size: 12 });
  page.drawText(`Продавец: ${brand}  |  Контакты: ${email}`, { x: 40, y: y - 70, size: 11, color: rgb(0.2,0.2,0.2) });

  y = 700;
  page.drawText("Товар", { x: 40, y, size: 12 });
  page.drawText("Кол-во", { x: 360, y, size: 12 });
  page.drawText("Цена", { x: 450, y, size: 12 });

  page.drawRectangle({ x: 38, y: y-8, width: width-76, height: 1, color: rgb(0.8,0.8,0.8) });

  y -= 24;
  page.drawText(product, { x: 40, y, size: 12 });
  page.drawText(String(qty), { x: 360, y, size: 12 });
  page.drawText(`${price.toLocaleString("ru-RU")} ₽`, { x: 450, y, size: 12 });

  y -= 32;
  page.drawRectangle({ x: 38, y: y-8, width: width-76, height: 1, color: rgb(0.8,0.8,0.8) });

  y -= 24;
  page.drawText(`IMEI: ${imei}`, { x: 40, y, size: 12 });

  y -= 40;
  page.drawText("Условия гарантии:", { x: 40, y, size: 12 });
  const terms = [
    "Срок гарантии 12 месяцев на продукцию Apple с даты продажи.",
    "Обслуживание по результатам диагностики авторизованного сервиса.",
    "Не покрываются: механические/термические повреждения, влага, вмешательство, ПО, аксессуары, расходники.",
    "Сохранность чека/заказа и соответствие IMEI обязательны.",
    "Срок ремонта/замены до 45 дней. Территория действия — РФ."
  ];
  y -= 18;
  for (const line of terms) {
    page.drawText(`• ${line}`, { x: 50, y, size: 10, color: rgb(0.2,0.2,0.2) });
    y -= 14;
  }

  // Подпись и печать
  if (sign) {
    const w = 220;
    const scale = w / sign.width;
    const h = sign.height * scale;
    page.drawImage(sign, { x: 60, y: 140, width: w, height: h });
  }
  if (stamp) {
    const w = 160;
    const scale = w / stamp.width;
    const h = stamp.height * scale;
    page.drawImage(stamp, { x: 360, y: 120, width: w, height: h });
  }

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

// ----------------- Старт -----------------
app.listen(PORT, async () => {
  console.log("Server listening on " + PORT);

  try {
    // Сбрасываем возможный вебхук и висящие апдейты, чтобы избежать 409
    await bot.api.deleteWebhook({ drop_pending_updates: true });
  } catch (e) {
    console.warn("deleteWebhook warning:", e?.description || e?.message || e);
  }

  // Аккуратное завершение при рестартах
  const stop = () => {
    try { bot.stop(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await bot.start({
    onStart: () => console.log("Bot started"),
    allowed_updates: ["message", "callback_query"]
  });
});
