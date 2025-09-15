import express from "express";
import { Bot, InputFile, webhookCallback } from "grammy";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import dayjs from "dayjs";
import fs from "fs/promises";
import path from "path";
import url from "url";

// ================== Конфигурация ==================
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const MANAGER_USERNAMES = (process.env.MANAGER_USERNAMES || "")
  .split(",").map(s => s.trim().replace(/^@/, "")).filter(Boolean);
const BRAND_NAME = process.env.BRAND_NAME || "iGadGetGo";
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "info@igadgetgo.ru";
const BASE_URL = process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL; // https://...onrender.com
const CURRENCY_SYMBOL = process.env.CURRENCY_SYMBOL || "руб."; // поставьте "₽", если ваш font.ttf его поддерживает

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN");
  process.exit(1);
}

const WEBHOOK_PATH = `/webhook/${encodeURIComponent(BOT_TOKEN)}`;
const WEBHOOK_URL = BASE_URL ? `${BASE_URL}${WEBHOOK_PATH}` : null;

// ================== App/Bot ==================
const app = express();
app.get("/", (_, res) => res.send("OK igadgetgo warranty bot (webhook + Cyrillic font)"));

const bot = new Bot(BOT_TOKEN);

// Память: ждём IMEI
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
    "Перешлите сюда уведомление о заказе из конструктора (с строками:\n" +
    "«Новый заказ №…», «… x 1 шт.», «Общая стоимость заказа: … ₽»).\n" +
    "После разбора попрошу IMEI и пришлю PDF. IMEI можно вводить с пробелами."
  );
});

bot.on("message:text", async (ctx) => {
  try {
    if (!isManager(ctx)) return;

    const pending = chatIdToPending.get(ctx.chat.id);
    const text = (ctx.message.text || "").trim();

    // Шаг 2: ждём IMEI
    if (pending) {
      const imeiDigits = text.replace(/\D+/g, "");
      if (imeiDigits.length < 8 || imeiDigits.length > 20) {
        await ctx.reply("IMEI должен содержать 8–20 цифр. Отправьте ещё раз.");
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
        await ctx.replyWithDocument(new InputFile(pdf, `warranty_${pending.orderId || "manual"}.pdf`));
      } catch (err) {
        console.error("PDF generation error:", err);
        await ctx.reply("Не удалось сформировать PDF. Проверьте assets: logo.(png/jpg), stamp.(png/jpg), signature.(png/jpg), font.ttf (кириллица).");
      }
      return;
    }

    // Шаг 1: парсим уведомление
    const parsed = parseOrder(text);
    if (!parsed) {
      await ctx.reply(
        "Не смог распознать заказ. Перешлите полноценное уведомление из конструктора.\n" +
        "Нужны строки:\n— Новый заказ №<id>\n— <товар> x <число> шт.\n— Общая стоимость заказа: <цена> ₽"
      );
      return;
    }

    chatIdToPending.set(ctx.chat.id, parsed);
    await ctx.reply(
      `Заказ принят:\n` +
      `Товар: ${parsed.product}\n` +
      `Кол-во: ${parsed.qty}\n` +
      `Цена: ${formatPrice(parsed.price)}\n\n` +
      `Введите IMEI (можно с пробелами — я оставлю только цифры).`
    );
  } catch (e) {
    console.error("Handler error:", e);
    try { await ctx.reply("Произошла ошибка. Пришлите текст заказа ещё раз или IMEI повторно."); } catch {}
  }
});

// ================== Парсер уведомления ==================
function parseOrder(raw) {
  const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);

  const orderLine = lines.find(l => /^Новый заказ №/i.test(l));
  const orderId = orderLine?.match(/№\s*([A-Za-z0-9_-]+)/)?.[1];

  const productLine = lines.find(l => /x\s*\d+\s*шт\.?/i.test(l)) || "";
  const qty = Number(productLine.match(/x\s*(\d+)\s*шт/i)?.[1] || "1");
  const product = productLine.replace(/\s*x\s*\d+\s*шт\.?/i, "").trim();

  const priceLine = lines.find(l => /^Общая стоимость заказа:/i.test(l)) || "";
  const priceDigits = (priceLine.match(/([\d\s]+)\s*₽/)?.[1] || "").replace(/\s+/g, "");
  const price = Number(priceDigits || "0");

  if (!product || !qty || !price) {
    console.log("Parse failed:", { product, qty, price, sample: raw.slice(0, 200) });
    return null;
  }
  return { product, qty, price, orderId };
}

// ================== Загрузка изображений/шрифта ==================
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

async function loadImage(relBase) {
  const candidates = [`${relBase}.png`, `${relBase}.jpg`, `${relBase}.jpeg`];
  for (const name of candidates) {
    const full = path.join(__dirname, "assets", name);
    try {
      const buf = await fs.readFile(full);
      return { buf, ext: path.extname(name).toLowerCase() }; // ".png" | ".jpg" | ".jpeg"
    } catch {}
  }
  console.warn(`Image not found: ${relBase}`);
  return null;
}

async function embedImageAuto(pdfDoc, image) {
  if (!image) return null;
  try {
    if (image.ext === ".png") return await pdfDoc.embedPng(image.buf);
    return await pdfDoc.embedJpg(image.buf);
  } catch (e) {
    console.error("Embed image error:", e);
    return null;
  }
}

async function loadFontBytes() {
  const candidates = ["font.ttf", "NotoSans-Regular.ttf", "Inter-Regular.ttf", "DejaVuSans.ttf"];
  for (const name of candidates) {
    try {
      return await fs.readFile(path.join(__dirname, "assets", name));
    } catch {}
  }
  throw new Error("font.ttf (кириллица) не найден в assets");
}

// ================== Утилиты ==================
function formatPrice(price) {
  return `${price.toLocaleString("ru-RU")} ${CURRENCY_SYMBOL}`;
}

// ================== PDF генерация ==================
async function makePdf({ brand, email, date, product, qty, price, orderId, imei }) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);
  const fontBytes = await loadFontBytes();
  const font = await pdfDoc.embedFont(fontBytes, { subset: true });

  const page = pdfDoc.addPage([595.28, 841.89]); // A4
  const { width } = page.getSize();

  const logo = await embedImageAuto(pdfDoc, await loadImage("logo"));
  const stamp = await embedImageAuto(pdfDoc, await loadImage("stamp"));
  const sign  = await embedImageAuto(pdfDoc, await loadImage("signature"));

  let y = 790;

  // ЛОГО: правый верхний угол
  if (logo) {
    const w = 120;
    const scale = w / logo.width;
    const h = logo.height * scale;
    const x = width - 40 - w;
    page.drawImage(logo, { x, y: y - h, width: w, height: h });
  }

  const header = { size: 14, font, color: rgb(0,0,0) };
  const text   = { size: 12, font, color: rgb(0,0,0) };
  const small  = { size: 11, font, color: rgb(0.2,0.2,0.2) };

  page.drawText(`Гарантийный документ № W-${orderId || "manual"}-${dayjs().format("YYMMDD")}`, { x: 40, y: y - 30, ...header });
  page.drawText(`Дата: ${date}`, { x: 40, y: y - 50, ...text });
  page.drawText(`Продавец: ${brand}  |  Контакты: ${email}`, { x: 40, y: y - 70, ...small });

  y = 700;
  page.drawText("Товар", { x: 40, y, ...text });
  page.drawText("Кол-во", { x: 360, y, ...text });
  page.drawText("Цена", { x: 450, y, ...text });
  page.drawRectangle({ x: 38, y: y-8, width: 595.28-76, height: 1, color: rgb(0.8,0.8,0.8) });

  y -= 24;
  page.drawText(product, { x: 40, y, ...text });
  page.drawText(String(qty), { x: 360, y, ...text });

  // Цена с безопасным символом валюты
  const priceStr = formatPrice(price);
  page.drawText(priceStr, { x: 450, y, ...text });

  y -= 32;
  page.drawRectangle({ x: 38, y: y-8, width: 595.28-76, height: 1, color: rgb(0.8,0.8,0.8) });

  y -= 24;
  page.drawText(`IMEI: ${imei}`, { x: 40, y, ...text });

  y -= 40;
  page.drawText("Условия гарантии:", { x: 40, y, ...text });
  const terms = [
    "Срок гарантии 12 месяцев на продукцию Apple с даты продажи.",
    "Обслуживание по результатам диагностики авторизованного сервиса.",
    "Не покрываются: механические/термические повреждения, влага, вмешательство, ПО, аксессуары, расходники.",
    "Сохранность чека/заказа и соответствие IMEI обязательны.",
    "Срок ремонта/замены до 45 дней. Территория действия — РФ."
  ];
  y -= 18;
  for (const line of terms) {
    page.drawText(`• ${line}`, { x: 50, y, size: 10, font, color: rgb(0.2,0.2,0.2) });
    y -= 14;
  }

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

// ================== Старт (webhook) ==================
app.use(express.json());
app.use(WEBHOOK_PATH, webhookCallback(bot, "express"));

app.listen(PORT, async () => {
  console.log("Server listening on " + PORT);

  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    if (!WEBHOOK_URL) {
      console.warn("BASE_URL/RENDER_EXTERNAL_URL не задан. Установите переменную окружения BASE_URL (публичный URL сервиса Render) и перезапустите.");
    } else {
      await bot.api.setWebhook(WEBHOOK_URL, { allowed_updates: ["message", "callback_query"] });
      console.log("Webhook set to:", WEBHOOK_URL);
    }
  } catch (e) {
    console.error("Webhook setup error:", e);
  }
});
