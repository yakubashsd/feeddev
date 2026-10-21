const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { del, list, put } = require("@vercel/blob");
const { PLAN, createSaasStore, isSubscriptionActive, normalizeEmail } = require("./saas-store");
const { createFreeKassa } = require("./freekassa");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const FEEDS_DIR = path.join(DATA_DIR, "feeds");
const LAYOUTS_DIR = path.join(DATA_DIR, "layouts");
const INDEX_FILE = path.join(DATA_DIR, "feeds-index.json");
const LAYOUTS_INDEX_FILE = path.join(DATA_DIR, "layouts-index.json");
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const MAX_LAYOUT_BYTES = 12 * 1024 * 1024;
const AUTH_USERNAME = String(process.env.AUTH_USERNAME || "sozdateli");
const AUTH_PASSWORD = String(process.env.AUTH_PASSWORD || "");
const AUTH_SECRET = String(process.env.AUTH_SECRET || AUTH_PASSWORD);
const AUTH_COOKIE = "feeddev_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const APP_MODE = String(process.env.APP_MODE || "internal").toLowerCase() === "external" ? "external" : "internal";
const SAAS_SESSION_SECRET = String(process.env.SAAS_SESSION_SECRET || "");
const SESSION_SECRET = APP_MODE === "external" ? SAAS_SESSION_SECRET : AUTH_SECRET;
const EXTERNAL_ADMIN_EMAIL = normalizeEmail(process.env.EXTERNAL_ADMIN_EMAIL);
const EXTERNAL_ADMIN_PASSWORD = String(process.env.EXTERNAL_ADMIN_PASSWORD || "");
const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "");
const TELEGRAM_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "");
const SMTP_HOST = String(process.env.SMTP_HOST || "");
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
const SMTP_USER = String(process.env.SMTP_USER || "");
const SMTP_PASS = String(process.env.SMTP_PASS || "");
const EMAIL_FROM = String(process.env.EMAIL_FROM || SMTP_USER || "");
const MONITOR_INTERVAL_MINUTES = 12 * 60;
const telegramLinks = require('./telegram-link').createTelegramLinks({file:path.join(DATA_DIR,'telegram-links.json')});
const saasStore = APP_MODE === "external" && process.env.SAAS_DATA_SECRET
  ? createSaasStore({ dataDir: DATA_DIR, secret: process.env.SAAS_DATA_SECRET })
  : null;
const freeKassa = createFreeKassa({
  merchantId: process.env.FREEKASSA_MERCHANT_ID,
  secret1: process.env.FREEKASSA_SECRET_1,
  secret2: process.env.FREEKASSA_SECRET_2,
  paymentUrl: process.env.FREEKASSA_PAYMENT_URL
});
async function telegramApi(method, body={}) {
  if(!TELEGRAM_BOT_TOKEN)throw Error('Бот ещё не настроен. Обратитесь к администратору.');
  const response=await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const result=await response.json();
  if(!response.ok || !result.ok)throw Error('Telegram недоступен. Проверьте настройки бота.');
  return result.result;
}
let pollingTelegram=false;
async function pollTelegram(){
  if(!TELEGRAM_BOT_TOKEN || pollingTelegram)return;
  pollingTelegram=true;
  try { for(const update of await telegramApi('getUpdates',{offset:telegramLinks.offset(),timeout:20,allowed_updates:['message']}))telegramLinks.accept(update); }
  catch { console.error('Telegram: не удалось получить сообщения бота'); }
  finally {pollingTelegram=false;}
}
const monitor = require('./feed-monitor').createMonitor({file:path.join(DATA_DIR,'monitor.json'),notify:sendMonitorAlerts,intervalMs:MONITOR_INTERVAL_MINUTES*60*1000});

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".pdf": "application/pdf"
};

function ensureStorage() {
  fs.mkdirSync(FEEDS_DIR, { recursive: true });
  fs.mkdirSync(LAYOUTS_DIR, { recursive: true });
  if (!fs.existsSync(INDEX_FILE)) fs.writeFileSync(INDEX_FILE, "[]\n");
  if (!fs.existsSync(LAYOUTS_INDEX_FILE)) fs.writeFileSync(LAYOUTS_INDEX_FILE, "[]\n");
}

function usesBlobStorage() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function canUseLocalStorage() {
  return !process.env.VERCEL;
}

function requireWritableStorage() {
  if (usesBlobStorage() || canUseLocalStorage()) return;
  throw new Error("Vercel Blob не подключен. Добавьте BLOB_READ_WRITE_TOKEN в Environment Variables для Production и сделайте Redeploy.");
}

function telegramAlertsEnabled(chatId = TELEGRAM_CHAT_ID) {
  return Boolean(TELEGRAM_BOT_TOKEN && chatId);
}

function emailAlertsEnabled() {
  return Boolean(SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS && EMAIL_FROM);
}

function readLocalIndex() {
  ensureStorage();
  try {
    const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalIndex(feeds) {
  ensureStorage();
  fs.writeFileSync(INDEX_FILE, `${JSON.stringify(feeds, null, 2)}\n`);
}

function readLocalLayoutsIndex() {
  ensureStorage();
  try {
    const parsed = JSON.parse(fs.readFileSync(LAYOUTS_INDEX_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalLayoutsIndex(layouts) {
  ensureStorage();
  fs.writeFileSync(LAYOUTS_INDEX_FILE, `${JSON.stringify(layouts, null, 2)}\n`);
}

async function readFeeds() {
  if (!usesBlobStorage() && !canUseLocalStorage()) return [];
  if (!usesBlobStorage()) return readLocalIndex();

  const result = await list({ prefix: "feed-records/", limit: 1000 });
  const records = await Promise.all(result.blobs.map(async blob => {
    const response = await fetch(blob.url, { cache: "no-store" });
    return response.ok ? response.json() : null;
  }));

  return records
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

async function readLayouts() {
  if (!usesBlobStorage() && !canUseLocalStorage()) return [];
  if (!usesBlobStorage()) return readLocalLayoutsIndex();

  const result = await list({ prefix: "layout-records/", limit: 1000 });
  const records = await Promise.all(result.blobs.map(async blob => {
    const response = await fetch(blob.url, { cache: "no-store" });
    return response.ok ? response.json() : null;
  }));

  return records
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

async function persistFeedXml(slug, xml) {
  requireWritableStorage();
  if (!usesBlobStorage()) {
    ensureStorage();
    fs.writeFileSync(path.join(FEEDS_DIR, `${slug}.xml`), xml);
    return null;
  }

  return put(`feeds/${slug}.xml`, xml, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/xml; charset=utf-8",
    cacheControlMaxAge: 60
  });
}

async function persistFeedRecord(record) {
  requireWritableStorage();
  if (!usesBlobStorage()) {
    const feeds = readLocalIndex().filter(feed => feed.slug !== record.slug);
    feeds.unshift(record);
    writeLocalIndex(feeds);
    return;
  }

  await put(`feed-records/${record.slug}.json`, JSON.stringify(record), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json; charset=utf-8",
    cacheControlMaxAge: 60
  });
}

async function persistLayoutFile(fileName, bytes, contentType) {
  requireWritableStorage();
  if (!usesBlobStorage()) {
    ensureStorage();
    fs.writeFileSync(path.join(LAYOUTS_DIR, fileName), bytes);
    return null;
  }

  return put(`layouts/${fileName}`, bytes, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType,
    cacheControlMaxAge: 31536000
  });
}

async function persistLayoutRecord(record) {
  requireWritableStorage();
  if (!usesBlobStorage()) {
    const layouts = readLocalLayoutsIndex().filter(layout => layout.id !== record.id);
    layouts.unshift(record);
    writeLocalLayoutsIndex(layouts);
    return;
  }

  await put(`layout-records/${record.id}.json`, JSON.stringify(record), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json; charset=utf-8",
    cacheControlMaxAge: 60
  });
}

async function deleteLayoutRecord(id) {
  const layouts = await readLayouts();
  const target = layouts.find(layout => layout.id === id);
  if (!target) return false;

  if (!usesBlobStorage()) {
    const filePath = path.join(LAYOUTS_DIR, target.fileName || "");
    if (filePath.startsWith(LAYOUTS_DIR) && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    writeLocalLayoutsIndex(layouts.filter(layout => layout.id !== id));
    return true;
  }

  await Promise.allSettled([
    del(`layouts/${target.fileName}`),
    del(`layout-records/${target.id}.json`)
  ]);
  return true;
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(type.includes("json") ? JSON.stringify(body) : body);
}

function sendError(res, status, message) {
  send(res, status, { error: message });
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(req) {
  return String(req.headers.cookie || "").split(";").reduce((cookies, part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return cookies;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) cookies[key] = value;
    return cookies;
  }, {});
}

function signSession(payload) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
}

function createSessionToken(subject) {
  const payload = Buffer.from(JSON.stringify({
    ...subject,
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000
  })).toString("base64url");
  return `${payload}.${signSession(payload)}`;
}

function readSession(req) {
  if (!SESSION_SECRET) return null;
  const token = parseCookies(req)[AUTH_COOKIE] || "";
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !safeEqual(signature, signSession(payload))) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (Number(session.expiresAt) <= Date.now()) return null;
    if (APP_MODE === "internal") return session.role === "internal" && session.username === AUTH_USERNAME ? session : null;
    return ["customer", "admin"].includes(session.role) ? session : null;
  } catch {
    return null;
  }
}

function isAuthenticated(req) {
  return Boolean(readSession(req));
}

async function currentActor(req) {
  const session = readSession(req);
  if (!session) return null;
  if (session.role !== "customer") return session;
  const user = await saasStore?.getUser(session.userId);
  return user && user.status !== "blocked" ? { ...session, user } : null;
}

function setSessionCookie(req, res, token, maxAge = SESSION_TTL_SECONDS) {
  const isSecure = Boolean(process.env.VERCEL) || req.headers["x-forwarded-proto"] === "https";
  res.setHeader("Set-Cookie", [
    `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isSecure ? "; Secure" : ""}`
  ]);
}

function parseBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "object") return Promise.resolve(req.body);
    if (String(req.headers["content-type"] || "").toLowerCase().includes("application/x-www-form-urlencoded")) {
      return Promise.resolve(Object.fromEntries(new URLSearchParams(String(req.body))));
    }
    try {
      return Promise.resolve(JSON.parse(String(req.body)));
    } catch {
      return Promise.reject(new Error("Некорректный JSON в запросе."));
    }
  }

  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Фид слишком большой. Максимум 20 МБ для MVP."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        const contentType = String(req.headers["content-type"] || "").toLowerCase();
        if (contentType.includes("application/x-www-form-urlencoded")) {
          resolve(Object.fromEntries(new URLSearchParams(raw)));
        } else {
          resolve(raw ? JSON.parse(raw) : {});
        }
      } catch {
        reject(new Error("Некорректный JSON в запросе."));
      }
    });
    req.on("error", reject);
  });
}

const translitMap = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya"
};

function transliterate(value = "") {
  return String(value).replace(/[а-яё]/gi, char => {
    const lower = char.toLowerCase();
    const next = translitMap[lower] || "";
    return char === lower ? next : next.toUpperCase();
  });
}

function makeSlug(value = "") {
  const cleaned = String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[а-яё]/gi, char => transliterate(char))
    .toLowerCase()
    .replace(/\.(xml|php)$/i, "")
    .replace(/[^a-z0-9-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || crypto.randomBytes(5).toString("hex");
}

function feedUrl(req, slug) {
  const base = PUBLIC_BASE_URL || `http://${req.headers.host}`;
  return `${base}/f/${slug}.php`;
}

function layoutUrl(req, fileName) {
  const base = PUBLIC_BASE_URL || `http://${req.headers.host}`;
  return `${base}/layouts/${encodeURIComponent(fileName)}`;
}

function imageContentTypeFromPath(value = "") {
  const pathname = (() => {
    try {
      return new URL(value).pathname;
    } catch {
      return value;
    }
  })().toLowerCase();
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "image/jpeg";
  if (pathname.endsWith(".webp")) return "image/webp";
  if (pathname.endsWith(".gif")) return "image/gif";
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  return "";
}

function urlsFromXmlFragment(xml) {
  return [...String(xml || "").matchAll(/\burl\s*=\s*(["'])(.*?)\1/gi)]
    .map((match) => match[2].trim())
    .filter(Boolean);
}

function assertBrandedLayoutsHaveApartmentSource(xml, sourceUrl) {
  const isProfitbaseFeed = /profitbase\.ru/i.test(String(sourceUrl || "")) || /profitbase\.ru/i.test(xml);
  if (!isProfitbaseFeed) return;

  const ads = String(xml).match(/<Ad\b[^>]*>[\s\S]*?<\/Ad>/gi) || [];
  const invalidAds = [];
  for (const ad of ads) {
    const imageUrls = urlsFromXmlFragment(ad);
    const hasBrandedLayout = imageUrls.some((url) => /\/layouts\/planirovka-na-podlozhke-/i.test(url));
    const hasApartmentSource = imageUrls.some((url) => /\/uploads\/preset\//i.test(url));
    if (hasBrandedLayout && !hasApartmentSource) {
      const id = ad.match(/\b(?:Id|id)\s*=\s*["']([^"']+)/)?.[1] || "без ID";
      invalidAds.push(id);
    }
  }

  if (invalidAds.length) {
    throw new Error(
      `Нельзя опубликовать: у ${invalidAds.length} брендированных объектов нет исходной квартирной планировки (${invalidAds.slice(0, 5).join(", ")}). ` +
      "Обновите источник Profitbase и пересоберите макеты."
    );
  }
}

function validateFeedPayload(payload) {
  const xml = String(payload.xml || "").trim();
  if (!xml) throw new Error("XML фида пустой.");
  if (!xml.includes("<") || !xml.includes(">")) throw new Error("Содержимое не похоже на XML.");
  const platform = String(payload.platform || "cian").trim() || "cian";
  const sourceUrl = String(payload.sourceUrl || "").trim();
  assertBrandedLayoutsHaveApartmentSource(xml, sourceUrl);
  return {
    xml,
    platform,
    sourceUrl,
    name: String(payload.name || "").trim(),
    sourceType: String(payload.sourceType || "").trim()
  };
}

async function saveFeed(req, payload, existingSlug = "", actor = null) {
  const data = validateFeedPayload(payload);
  const feeds = await readFeeds();
  const now = new Date().toISOString();
  const requestedSlug = existingSlug || payload.slug || data.name || `${data.platform}-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString("hex")}`;
  let slug = makeSlug(requestedSlug);
  const existing = feeds.find(feed => feed.slug === slug);
  if (APP_MODE === "external" && existingSlug && existing?.ownerId !== actor?.userId) {
    throw new Error("Фид не найден в вашем аккаунте.");
  }

  if (!existingSlug && existing) {
    slug = `${slug}-${crypto.randomBytes(3).toString("hex")}`;
  }

  const blob = await persistFeedXml(slug, data.xml);

  const record = {
    id: slug,
    slug,
    ownerId: APP_MODE === "external" ? actor?.userId : undefined,
    projectId: APP_MODE === "external" ? String(payload.projectId || "") : undefined,
    platform: data.platform,
    sourceUrl: data.sourceUrl,
    sourceType: data.sourceType,
    name: data.name || `${data.platform} feed`,
    objectCount: Number(payload.objectCount || 0),
    file: `feeds/${slug}.xml`,
    blobUrl: blob?.url || "",
    url: feedUrl(req, slug),
    updatedAt: now,
    createdAt: existing?.createdAt || now
  };

  await persistFeedRecord(record);
  return record;
}

function validateLayoutPayload(payload) {
  const name = String(payload.name || "").trim();
  const fileName = String(payload.fileName || "").trim();
  const contentType = String(payload.contentType || "").trim();
  const fileBase64 = String(payload.fileBase64 || "").trim();
  const allowedTypes = new Set(["image/png", "image/jpeg", "image/webp", "application/pdf"]);
  if (!name) throw new Error("Укажите название планировки.");
  if (!fileName) throw new Error("Не передано имя файла.");
  if (!allowedTypes.has(contentType)) throw new Error("Поддерживаются PNG, JPG, WebP и PDF.");
  if (!fileBase64) throw new Error("Файл планировки пустой.");

  const ext = path.extname(fileName).toLowerCase();
  const allowedExt = new Set([".png", ".jpg", ".jpeg", ".webp", ".pdf"]);
  if (!allowedExt.has(ext)) throw new Error("Расширение файла должно быть PNG, JPG, WebP или PDF.");

  const bytes = Buffer.from(fileBase64, "base64");
  if (!bytes.length) throw new Error("Файл планировки пустой.");
  if (bytes.length > MAX_LAYOUT_BYTES) throw new Error("Планировка слишком большая. Максимум 12 МБ.");

  return {
    name,
    originalFileName: fileName,
    contentType,
    ext,
    bytes,
    project: String(payload.project || "").trim(),
    building: String(payload.building || "").trim(),
    rooms: String(payload.rooms || "").trim(),
    area: String(payload.area || "").trim(),
    tags: String(payload.tags || "").trim()
  };
}

async function saveLayout(req, payload, actor = null) {
  const data = validateLayoutPayload(payload);
  const now = new Date().toISOString();
  const baseSlug = makeSlug(`${data.name}-${data.rooms || ""}-${data.area || ""}`) || crypto.randomBytes(5).toString("hex");
  const id = `${baseSlug}-${crypto.randomBytes(3).toString("hex")}`;
  const fileName = `${id}${data.ext}`;
  const blob = await persistLayoutFile(fileName, data.bytes, data.contentType);
  const record = {
    id,
    ownerId: APP_MODE === "external" ? actor?.userId : undefined,
    projectId: APP_MODE === "external" ? String(payload.projectId || "") : undefined,
    name: data.name,
    project: data.project,
    building: data.building,
    rooms: data.rooms,
    area: data.area,
    tags: data.tags,
    originalFileName: data.originalFileName,
    fileName,
    contentType: data.contentType,
    size: data.bytes.length,
    url: layoutUrl(req, fileName),
    blobUrl: blob?.url || "",
    updatedAt: now,
    createdAt: now
  };
  await persistLayoutRecord(record);
  return record;
}

function telegramMessage(payload = {}) {
  const lines = [
    "FeedDev: ошибка фида",
    `Проект: ${String(payload.projectName || "без названия").slice(0, 160)}`,
    `Фид: ${String(payload.name || "без названия").slice(0, 160)}`,
    `Площадка: ${String(payload.platform || "не определена").slice(0, 80)}`,
    `Ссылка: ${String(payload.url || "-").slice(0, 500)}`,
    `Ошибка: ${String(payload.error || "неизвестная ошибка").slice(0, 700)}`,
    `Проверка: ${new Date().toLocaleString("ru-RU", { timeZone: "Asia/Yekaterinburg" })}`
  ];
  return lines.join("\n");
}

async function sendTelegramAlert(payload) {
  const chatId = String(payload.telegramChatId || TELEGRAM_CHAT_ID || "").trim();
  if (!telegramAlertsEnabled(chatId)) {
    throw new Error("Telegram-уведомления не настроены. Добавьте TELEGRAM_BOT_TOKEN и укажите ID чата в проекте или TELEGRAM_CHAT_ID на сервере.");
  }

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: telegramMessage(payload),
      disable_web_page_preview: true
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok === false) {
    throw new Error(result.description || `Telegram вернул HTTP ${response.status}`);
  }
  return result;
}

function validEmail(value = "") {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim());
}

async function sendEmailAlert(payload) {
  if (!emailAlertsEnabled()) {
    throw new Error("Email-уведомления не настроены. Добавьте SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS и EMAIL_FROM.");
  }
  const emailTo = String(payload.emailTo || "").trim();
  if (!validEmail(emailTo)) throw new Error("Укажите корректный email получателя уведомлений.");
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    disableFileAccess: true,
    disableUrlAccess: true
  });
  return transporter.sendMail({
    from: EMAIL_FROM,
    to: emailTo,
    subject: `FeedDev: ошибка фида «${String(payload.name || "без названия").slice(0, 120)}»`,
    text: telegramMessage(payload)
  });
}

async function sendMonitorAlerts(payload = {}) {
  const telegramOwner = APP_MODE === "external" ? String(payload.ownerId || "") : AUTH_USERNAME;
  const connection=telegramLinks.status(telegramOwner,payload.projectId || '').connected;
  payload={...payload,telegramChatId:connection?.chatId || ''};
  const result = { telegramSent: false, emailSent: false, errors: [] };
  if (payload.telegramEnabled) {
    try {
      if(!connection)throw Error('Подключите Telegram в настройках проекта.');
      await sendTelegramAlert(payload);
      result.telegramSent = true;
    } catch (error) {
      result.errors.push(`Telegram: ${error.message}`);
    }
  }
  if (payload.emailEnabled) {
    try {
      await sendEmailAlert(payload);
      result.emailSent = true;
    } catch (error) {
      result.errors.push(`Email: ${error.message}`);
    }
  }
  return result;
}

function serveStatic(req, res, pathname) {
  if (pathname.split('/').some(part=>part.startsWith('.')||part==='data'||part==='node_modules') || !['/','/feed-generator.html','/admin.html','/layout-editor.js','/layout-editor.css','/monitor-client.js','/robots.txt'].includes(pathname) && !/\.(png|jpe?g|webp|svg|ico|woff2?)$/i.test(pathname)) return sendError(res,404,'Not found');
  const filePath = pathname === "/" ? path.join(ROOT, "feed-generator.html") : path.join(ROOT, pathname);
  if (!filePath.startsWith(ROOT)) return sendError(res, 403, "Forbidden");
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return sendError(res, 404, "Not found");
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": mimeTypes[ext] || "application/octet-stream",
    "Cache-Control": "no-store"
  });
  fs.createReadStream(filePath).pipe(res);
}

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") return send(res, 204, {});

  if (req.method === "GET" && url.pathname === "/api/health") {
    return send(res, 200, {
      ok: true,
      mode: APP_MODE,
      storage: usesBlobStorage() ? "vercel-blob" : "local",
      feedPublishingReady: usesBlobStorage() || !process.env.VERCEL,
      telegramAlertsReady: telegramAlertsEnabled(),
      emailAlertsReady: emailAlertsEnabled(),
      billingReady: APP_MODE === "external" ? freeKassa.configured() : null
    });
  }

  if (req.method === "GET" && url.pathname === "/api/auth-session") {
    const actor = await currentActor(req);
    return send(res, 200, {
      authenticated: Boolean(actor),
      configured: APP_MODE === "external" ? Boolean(saasStore && SESSION_SECRET) : Boolean(AUTH_PASSWORD && AUTH_SECRET),
      mode: APP_MODE,
      role: actor?.role || null,
      user: actor?.user || null,
      subscriptionActive: actor?.user ? isSubscriptionActive(actor.user) : APP_MODE === "internal",
      plan: APP_MODE === "external" ? PLAN : null
    });
  }

  if (req.method === "POST" && url.pathname === "/api/auth-register") {
    if (APP_MODE !== "external" || !saasStore) return sendError(res, 404, "Регистрация недоступна.");
    const payload = await parseBody(req);
    const user = await saasStore.register(payload);
    setSessionCookie(req, res, createSessionToken({ role: "customer", userId: user.id }));
    return send(res, 201, { authenticated: true, user, subscriptionActive: false, plan: PLAN });
  }

  if (req.method === "POST" && url.pathname === "/api/auth-login") {
    const payload = await parseBody(req);
    if (APP_MODE === "external") {
      if (!saasStore || !SESSION_SECRET) return sendError(res, 503, "Внешний контур ещё не настроен.");
      const email = normalizeEmail(payload.email || payload.username);
      if (email === EXTERNAL_ADMIN_EMAIL && EXTERNAL_ADMIN_PASSWORD && safeEqual(payload.password || "", EXTERNAL_ADMIN_PASSWORD)) {
        setSessionCookie(req, res, createSessionToken({ role: "admin", email }));
        return send(res, 200, { authenticated: true, role: "admin" });
      }
      const user = await saasStore.authenticate(email, payload.password || "");
      if (!user) return sendError(res, 401, "Неверный email или пароль.");
      setSessionCookie(req, res, createSessionToken({ role: "customer", userId: user.id }));
      return send(res, 200, { authenticated: true, role: "customer" });
    }
    if (!AUTH_PASSWORD || !AUTH_SECRET) return sendError(res, 503, "Вход ещё не настроен на сервере.");
    const usernameMatches = safeEqual(payload.username || "", AUTH_USERNAME);
    const passwordMatches = safeEqual(payload.password || "", AUTH_PASSWORD);
    if (!usernameMatches || !passwordMatches) {
      return sendError(res, 401, "Неверный логин или пароль.");
    }
    setSessionCookie(req, res, createSessionToken({ role: "internal", username: AUTH_USERNAME }));
    return send(res, 200, { authenticated: true });
  }

  if (req.method === "POST" && url.pathname === "/api/auth-logout") {
    setSessionCookie(req, res, "", 0);
    return send(res, 200, { authenticated: false });
  }

  if (req.method === "GET" && url.pathname === "/api/public-feed") {
    return servePublicFeed(req, res, String(url.searchParams.get("slug") || ""));
  }

  if (req.method === "GET" && url.pathname === "/api/public-layout") {
    return servePublicLayout(req, res, String(url.searchParams.get("file") || ""));
  }

  if (req.method === "POST" && url.pathname === "/api/billing/freekassa/callback") {
    if (APP_MODE !== "external" || !saasStore || !freeKassa.configured()) return sendError(res, 503, "Касса не настроена.");
    const payload = await parseBody(req);
    if (!freeKassa.verifyNotification(payload)) return sendError(res, 403, "Неверная подпись уведомления.");
    const orderId = String(payload.MERCHANT_ORDER_ID || payload.order_id || "");
    await saasStore.completePayment(orderId, payload.intid || payload.INTID || "", payload.AMOUNT || payload.amount);
    return send(res, 200, "YES", "text/plain; charset=utf-8");
  }

  const actor = await currentActor(req);
  if (!actor) {
    return sendError(res, 401, "Требуется вход в сервис.");
  }

  if (APP_MODE === "external" && req.method === "GET" && url.pathname === "/api/projects") {
    if (actor.role !== "customer") return sendError(res, 403, "Раздел доступен клиентам.");
    return send(res, 200, { projects: await saasStore.listProjects(actor.userId), limit: actor.user.projectLimit || PLAN.minProjects });
  }

  if (APP_MODE === "external" && req.method === "POST" && url.pathname === "/api/projects") {
    if (actor.role !== "customer") return sendError(res, 403, "Раздел доступен клиентам.");
    const payload = await parseBody(req);
    return send(res, 201, await saasStore.createProject(actor.userId, payload.name));
  }

  const projectDeleteMatch = APP_MODE === "external" ? url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)$/i) : null;
  if (projectDeleteMatch && req.method === "DELETE") {
    if (actor.role !== "customer") return sendError(res, 403, "Раздел доступен клиентам.");
    const deleted = await saasStore.deleteProject(actor.userId, projectDeleteMatch[1]);
    return send(res, deleted ? 200 : 404, deleted ? { deleted: true } : { error: "Проект не найден." });
  }

  if (APP_MODE === "external" && req.method === "POST" && url.pathname === "/api/billing/checkout") {
    if (actor.role !== "customer") return sendError(res, 403, "Раздел доступен клиентам.");
    if (!freeKassa.configured()) return sendError(res, 503, "FreeKassa ещё не настроена администратором.");
    const payload = await parseBody(req);
    const payment = await saasStore.createPayment(actor.userId, payload.projectCount);
    return send(res, 201, { orderId: payment.orderId, url: freeKassa.checkoutUrl({ ...payment, email: actor.user.email }) });
  }

  if (APP_MODE === "external" && url.pathname === "/api/admin") {
    if (actor.role !== "admin") return sendError(res, 403, "Требуются права администратора.");
    if (req.method === "GET") return send(res, 200, await saasStore.adminSnapshot());
    if (req.method === "PUT") {
      const payload = await parseBody(req);
      return send(res, 200, await saasStore.updateUser(payload.userId, payload));
    }
    return sendError(res, 405, "Метод не поддерживается");
  }

  if (APP_MODE === "external" && actor.role === "customer" && !isSubscriptionActive(actor.user)) {
    return sendError(res, 402, "Для работы с сервисом оплатите тариф от 7 500 ₽ в месяц.");
  }

  if (req.method === "GET" && url.pathname === "/api/feeds") {
    const feeds = await readFeeds();
    return send(res, 200, { feeds: APP_MODE === "external" ? feeds.filter(feed => feed.ownerId === actor.userId) : feeds });
  }

  if (url.pathname === '/api/monitor') {
    if(process.env.VERCEL)return sendError(res,503,'Серверное расписание требует постоянно работающего Node-сервера. На Vercel оно пока не подключено.');
    const project=String(url.searchParams.get('project')||'default');
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(project))return sendError(res,400,'Некорректный проект');
    if(APP_MODE === "external" && !await saasStore.ownsProject(actor.userId, project))return sendError(res,403,'Проект недоступен.');
    if(req.method==='GET')return send(res,200,{feeds:monitor.read()[project]||[],intervalMinutes:MONITOR_INTERVAL_MINUTES});
    if(req.method==='PUT'){const body=await parseBody(req);return send(res,200,{feeds:monitor.replace(project,body.feeds)});}
    if(req.method==='POST'){const body=await parseBody(req);await monitor.run(project,body.id||null,true);return send(res,200,{feeds:monitor.read()[project]||[]});}
    return sendError(res,405,'Метод не поддерживается');
  }

  if(url.pathname==='/api/telegram-link'){
    const project=String(url.searchParams.get('project')||'');
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(project))return sendError(res,400,'Некорректный проект');
    if(APP_MODE === "external" && !await saasStore.ownsProject(actor.userId, project))return sendError(res,403,'Проект недоступен.');
    const telegramOwner = APP_MODE === "external" ? actor.userId : AUTH_USERNAME;
    if(req.method==='GET')return send(res,200,{...telegramLinks.status(telegramOwner,project),configured:Boolean(TELEGRAM_BOT_TOKEN)});
    if(req.method==='DELETE')return send(res,200,telegramLinks.disconnect(telegramOwner,project));
    if(req.method==='POST'){
      const body=await parseBody(req);
      if(body.confirmationId)return send(res,200,telegramLinks.confirm(telegramOwner,project,body.confirmationId));
      const bot=await telegramApi('getMe');
      const token=telegramLinks.begin(telegramOwner,project);
      return send(res,200,{url:`https://t.me/${bot.username}?start=${token}`,expiresIn:600});
    }
    return sendError(res,405,'Метод не поддерживается');
  }

  if (req.method === "POST" && url.pathname === "/api/monitor-alert") {
    return sendError(res,410,'Используйте серверную проверку мониторинга.');
  }

  if (req.method === "GET" && url.pathname === "/api/layouts") {
    const layouts = await readLayouts();
    return send(res, 200, { layouts: APP_MODE === "external" ? layouts.filter(layout => layout.ownerId === actor.userId) : layouts });
  }

  if (req.method === "GET" && url.pathname === "/api/layout-image-proxy") {
    return serveImageProxy(res, String(url.searchParams.get("url") || ""));
  }

  if (req.method === "POST" && url.pathname === "/api/layouts") {
    const payload = await parseBody(req);
    if (APP_MODE === "external" && !await saasStore.ownsProject(actor.userId, payload.projectId)) return sendError(res, 403, "Проект недоступен.");
    const record = await saveLayout(req, payload, actor);
    return send(res, 201, record);
  }

  const deleteLayoutMatch = url.pathname.match(/^\/api\/layouts\/([a-z0-9а-яё-]+)$/i);
  if (req.method === "DELETE" && deleteLayoutMatch) {
    if (APP_MODE === "external") {
      const target = (await readLayouts()).find(layout => layout.id === deleteLayoutMatch[1]);
      if (!target || target.ownerId !== actor.userId) return sendError(res, 404, "Планировка не найдена.");
    }
    const deleted = await deleteLayoutRecord(deleteLayoutMatch[1]);
    return send(res, deleted ? 200 : 404, deleted ? { deleted: true } : { error: "Планировка не найдена." });
  }

  if (req.method === "POST" && ["/api/feeds/import", "/api/feeds-import"].includes(url.pathname)) {
    const payload = await parseBody(req);
    const sourceUrl = String(payload.url || "").trim();
    if (!sourceUrl) return sendError(res, 400, "Передайте ссылку на фид.");
    const response = await fetch(sourceUrl, { headers: { "User-Agent": "FeedDev/0.1" } });
    if (!response.ok) return sendError(res, 502, `Источник вернул HTTP ${response.status}`);
    const xml = await response.text();
    return send(res, 200, { xml, sourceUrl });
  }

  if (req.method === "POST" && url.pathname === "/api/feeds") {
    const payload = await parseBody(req);
    if (APP_MODE === "external" && !await saasStore.ownsProject(actor.userId, payload.projectId)) return sendError(res, 403, "Проект недоступен.");
    const record = await saveFeed(req, payload, "", actor);
    return send(res, 201, record);
  }

  if (req.method === "PUT" && url.pathname === "/api/feeds" && url.searchParams.get("slug")) {
    const payload = await parseBody(req);
    if (APP_MODE === "external" && !await saasStore.ownsProject(actor.userId, payload.projectId)) return sendError(res, 403, "Проект недоступен.");
    const record = await saveFeed(req, payload, url.searchParams.get("slug"), actor);
    return send(res, 200, record);
  }

  const updateMatch = url.pathname.match(/^\/api\/feeds\/([a-z0-9а-яё-]+)$/i);
  if (req.method === "PUT" && updateMatch) {
    const payload = await parseBody(req);
    if (APP_MODE === "external" && !await saasStore.ownsProject(actor.userId, payload.projectId)) return sendError(res, 403, "Проект недоступен.");
    const record = await saveFeed(req, payload, updateMatch[1], actor);
    return send(res, 200, record);
  }

  return sendError(res, 404, "API route not found");
}

async function servePublicFeed(req, res, slug) {
  if (!/^[a-z0-9а-яё-]+$/i.test(slug)) return sendError(res, 400, "Invalid feed slug");

  if (usesBlobStorage()) {
    const record = (await readFeeds()).find(feed => feed.slug === slug);
    const sourceUrl = record?.blobUrl || record?.url;
    if (!sourceUrl) return sendError(res, 404, "Feed not found");
    const response = await fetch(sourceUrl, { cache: "no-store" });
    if (!response.ok) return sendError(res, 502, "Feed storage is unavailable");
    if (req.method === "HEAD") {
      res.writeHead(200, { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=60" });
      return res.end();
    }
    return send(res, 200, await response.text(), "application/xml; charset=utf-8");
  }

  const filePath = path.join(FEEDS_DIR, `${slug}.xml`);
  if (!fs.existsSync(filePath)) return sendError(res, 404, "Feed not found");
  res.writeHead(200, {
    "Content-Type": "application/xml; charset=utf-8",
    "Cache-Control": "public, max-age=60"
  });
  if (req.method === "HEAD") return res.end();
  return fs.createReadStream(filePath).pipe(res);
}

async function servePublicLayout(req, res, fileName) {
  fileName = decodeURIComponent(fileName);
  if (!/^[a-z0-9а-яё-]+\.(png|jpe?g|webp|pdf)$/i.test(fileName)) {
    return sendError(res, 400, "Invalid layout file name");
  }
  const ext = path.extname(fileName).toLowerCase();
  if (usesBlobStorage()) {
    const record = (await readLayouts()).find(layout => layout.fileName === fileName);
    if (!record?.blobUrl) return sendError(res, 404, "Layout not found");
    const response = await fetch(record.blobUrl, { cache: "no-store" });
    if (!response.ok) return sendError(res, 502, "Layout storage is unavailable");
    res.writeHead(200, {
      "Content-Type": record.contentType || mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000"
    });
    return res.end(Buffer.from(await response.arrayBuffer()));
  }
  const filePath = path.join(LAYOUTS_DIR, fileName);
  if (!filePath.startsWith(LAYOUTS_DIR) || !fs.existsSync(filePath)) return sendError(res, 404, "Layout not found");
  res.writeHead(200, {
    "Content-Type": mimeTypes[ext] || "application/octet-stream",
    "Cache-Control": "public, max-age=31536000"
  });
  return fs.createReadStream(filePath).pipe(res);
}

async function serveImageProxy(res, sourceUrl) {
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return sendError(res, 400, "Некорректная ссылка на изображение.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return sendError(res, 400, "Поддерживаются только http и https ссылки.");
  }

  const response = await fetch(parsed.href, {
    cache: "no-store",
    headers: { "User-Agent": "FeedDev/0.1" }
  });
  if (!response.ok) return sendError(res, 502, `Источник изображения вернул HTTP ${response.status}`);

  const headerContentType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const inferredContentType = imageContentTypeFromPath(parsed.href);
  const contentType = headerContentType.startsWith("image/") ? headerContentType : inferredContentType;
  if (!contentType.startsWith("image/")) {
    return sendError(res, 400, `Ссылка должна вести на изображение планировки. Источник вернул Content-Type: ${headerContentType || "не указан"}.`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_LAYOUT_BYTES) return sendError(res, 413, "Изображение слишком большое. Максимум 12 МБ.");

  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  return res.end(bytes);
}

async function handleRequest(req, res) {
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const publicFeedMatch = url.pathname.match(/^\/f\/([a-z0-9а-яё-]+)\.(php|xml)$/i);
    const publicLayoutMatch = url.pathname.match(/^\/layouts\/([^/]+)$/i);

    if (publicFeedMatch && (req.method === "GET" || req.method === "HEAD")) {
      return servePublicFeed(req, res, publicFeedMatch[1]);
    }

    if (publicLayoutMatch && req.method === "GET") {
      return servePublicLayout(req, res, publicLayoutMatch[1]);
    }

    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return serveStatic(req, res, decodeURIComponent(url.pathname));
  } catch (error) {
    return sendError(res, 500, error.message || "Server error");
  }
}

if (require.main === module) {
  http.createServer(handleRequest).listen(PORT, () => {
    ensureStorage();
    console.log(`FeedDev server is running on http://localhost:${PORT}`);
    const tick=()=>monitor.run().catch(error=>console.error('Monitor:',error.message));
    tick();setInterval(tick,60000).unref();
    pollTelegram();setInterval(pollTelegram,25000).unref();
  });
}

module.exports = handleRequest;
