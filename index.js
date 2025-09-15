import express from "express";
import { Bot, InputFile } from "grammy";
import { PDFDocument, rgb } from "pdf-lib";
import dayjs from "dayjs";
import fs from "fs/promises";
import path from "path";
import url from "url";

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const MANAGER_USERNAMES = (process.env.MANAGER_USERNAMES || "")
  .split(",")
  .map(s => s.trim().replace(/^@/, ""))
  .filter(Boolean);
const BRAND_NAME = process.env.BRAND_NAME || "iGadGetGo";
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "info@igadgetgo.ru";
const TZ = process.env.TIMEZONE || "Europe/Moscow";

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN");
  process.exit(1);
}

const app = express();
app.get("/", (_, res) => res.send("OK igadgetgo warranty bot"));

const bot = new Bot(BOT_TOKEN);

// Простая in-memory сессия: chatId -> ожидается IMEI по заказу
const chatIdToPending = new Map();

function isManager(ctx) {
  const u = ctx.from?.username || "";
  return MANAGER_USERNAMES.includes(u);
}

bot.command("start", async (ctx) => {
  if (!isManager(ctx)) return;
  await ctx.reply(
    "Перешлите сюда уведомление о заказе из конструктора.\n" +
    "Я извлеку товар, количество и цену, затем попрошу IMEI и пришлю PDF."
  );
});

bot.on("message:text", async (ctx) => {
  if (!isManager(ctx)) return;

  const pending = chatIdToPending.get(ctx.chat.id);
  const text = ctx.message.text.trim();

  // Если ждём IMEI
  if (pending && /^\d{10,20}$/.test(text)) {
    const imei = text;
    chatIdToPending.delete(ctx.chat.id);

    const pdf = await makePdf({
      brand: BRAND_NAME,
      email: SUPPORT_EMAIL,
      date: formatDateMsk(),
      product: pending.product,
      qty: pending.qty,
      price: pending.price,
      orderId: pending.orderId || "manual",
      imei
    });

    await ctx.replyWithDocument(
      new InputFile(pdf, `warranty_${pending.orderId || "manual"}.pdf`)
    ).catch(async () => {
      await ctx.reply("PDF сформирован. Если файл не прикрепился — пришлите лог, я помогу.");
    });
    return;
  }

  // Пробуем распарсить пересланный текст заказа
  const parsed = parseOrder(text);
  if (!parsed) {
    await ctx.reply(
      "Не смог распознать заказ. Перешлите сообщение в формате конструктора.\n" +
      "Если я уже спросил IMEI — отправьте цифрами (10–20 символов)."
    );
    return;
  }

  chatIdToPending.set(ctx.chat.id, parsed);
  await ctx.reply(
    `Заказ принят:\n` +
    `Товар: ${parsed.product}\n` +
    `Кол-во: ${parsed.qty}\n` +
    `Цена: ${parsed.price.toLocaleString("ru-RU")} ₽\n\n` +
    `Введите IMEI (только цифры).`
  );
});

// ---------- Утилиты ----------

function formatDateMsk() {
  // Без доп.пакетов для TZ — используем локальное время хоста.
  // Render (Европа) даст UTC, но дата всё равно ок. При желании можно подключить dayjs-timezone.
  return dayjs().format("DD.MM.YYYY");
}

function parseOrder(raw) {
  // Ожидаемый формат (пример):
  // Новый заказ №3
  // Состав заказа:
  // iPhone16 Pro Max ... x 1 шт.
  // - Объем памяти: ...
  // Общая стоимость заказа: 100 300 ₽
  const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);

  const orderLine = lines.find(l => /^Новый заказ №/i.test(l));
  const orderId = orderLine?.match(/№\s*([A-Za-z0-9_-]+)/)?.[1];

  const productLine = lines.find(l => /x\s*\d+\s*шт\.?/i.test(l)) || "";
  const qty = Number(productLine.match(/x\s*(\d+)\s*шт/i)?.[1] || "1");
  const product = productLine.replace(/\s*x\s*\d+\s*шт\.?/i, "").trim();

  const priceLine = lines.find(l => /^Общая стоимость заказа:/i.test(l)) || "";
  const priceDigits = (priceLine.match(/([\d\s]+)\s*₽/)?.[1] || "").replace(/\s+/g, "");
  const price = Number(priceDigits || "0");

  if (!product || !qty || !price) return null;
  return { product, qty, price, orderId };
}

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

async function loadPngBuffer(rel) {
  try {
    return await fs.readFile(path.join(__dirname, "assets", rel));
  } catch {
    return null;
  }
}

async function makePdf({ brand, email, date, product, qty, price, orderId, imei }) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]); // A4
  const { width } = page.getSize();

  const logoPng = await loadPngBuffer("logo.png");
  const stampPng = await loadPngBuffer("stamp.png");
  const signPng  = await loadPngBuffer("signature.png");

  let y = 790;

  // Лого
  if (logoPng) {
    const logo = await pdfDoc.embedPng(logoPng);
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
  if (signPng) {
    const sign = await pdfDoc.embedPng(signPng);
    const w = 220;
    const scale = w / sign.width;
    const h = sign.height * scale;
    page.drawImage(sign, { x: 60, y: 140, width: w, height: h });
  }
  if (stampPng) {
    const stamp = await pdfDoc.embedPng(stampPng);
    const w = 160;
    const scale = w / stamp.width;
    const h = stamp.height * scale;
    page.drawImage(stamp, { x: 360, y: 120, width: w, height: h });
  }

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

app.listen(PORT, () => {
  console.log("Server listening on " + PORT);
  bot.start({
    onStart: () => console.log("Bot started"),
    allowed_updates: ["message", "callback_query"]
  });
});
