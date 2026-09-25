// Локальный запуск читает .env; на Selectel переменные задаются в окружении сервиса.
try {
  process.loadEnvFile?.(__dirname + "/.env");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { del, list, put } = require("@vercel/blob");
const { XMLParser, XMLValidator } = require("fast-xml-parser");
const { PLAN, createSaasStore, isSubscriptionActive, hasSubscriptionReadAccess, subscriptionGraceUntil, normalizeEmail } = require("./saas-store");
const { createProjectStateStore } = require("./project-state-store");
const { createSupportTicketStore } = require("./support-tickets");
const { createPlatega } = require("./platega");
const { inspectLaunchReadiness } = require("./launch-readiness");
const { records: feedRecords, synchronizeFeed } = require("./feed-sync");
const { download: safeDownload, downloadBuffer: safeDownloadBuffer } = require("./feed-monitor");

const PORT = Number(process.env.PORT || 3000);
const HOST = String(process.env.HOST || "127.0.0.1");
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
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
const TRUST_PROXY = String(process.env.TRUST_PROXY || "false").toLowerCase() === "true";
const PASSWORD_RESET_MINUTES = Math.max(5, Math.min(60, Number(process.env.PASSWORD_RESET_MINUTES || 30)));
const BACKUP_RETENTION_DAYS = Math.max(1, Number(process.env.BACKUP_RETENTION_DAYS || 30));
const BILLING_MODE = String(process.env.BILLING_MODE || "manual").toLowerCase() === "platega" ? "platega" : "manual";
const OFFER_VERSION = "2026-09-22";
const PRIVACY_VERSION = "2026-09-22";
const CONSENT_VERSION = "2026-09-22";
const ONLINE_RECEIPTS_READY = String(process.env.ONLINE_RECEIPTS_READY || "false").toLowerCase() === "true";
const LEGAL_PROFILE_CONFIRMED = String(process.env.LEGAL_PROFILE_CONFIRMED || "false").toLowerCase() === "true";
const LEGAL = {
  name: String(process.env.LEGAL_NAME || "ИП Якубаш Сергей Дмитриевич"),
  inn: String(process.env.LEGAL_INN || "720326517332"),
  ogrnip: String(process.env.LEGAL_OGRNIP || "326723200087150"),
  address: String(process.env.LEGAL_ADDRESS || "Тюменская область, г. Тюмень"),
  email: String(process.env.LEGAL_EMAIL || "yakubashsd@gmail.com"),
  phone: String(process.env.LEGAL_PHONE || "")
};
const LEGAL_PROFILE_READY = Boolean(
  LEGAL_PROFILE_CONFIRMED && LEGAL.name.trim().split(/\s+/).length >= 4 && /^\d{12}$/.test(LEGAL.inn) && /^\d{15}$/.test(LEGAL.ogrnip) &&
  LEGAL.address.trim().length >= 8 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(LEGAL.email)
);
const rateBuckets = new Map();
const MONITOR_INTERVAL_MINUTES = 12 * 60;
const telegramLinks = require('./telegram-link').createTelegramLinks({file:path.join(DATA_DIR,'telegram-links.json')});
const saasStore = APP_MODE === "external" && process.env.SAAS_DATA_SECRET
  ? createSaasStore({ dataDir: DATA_DIR, secret: process.env.SAAS_DATA_SECRET })
  : null;
const projectStateStore = APP_MODE === "external" && process.env.SAAS_DATA_SECRET
  ? createProjectStateStore({ dataDir: DATA_DIR, secret: process.env.SAAS_DATA_SECRET })
  : null;
const SUPPORT_DATA_SECRET = String(process.env.SAAS_DATA_SECRET || SAAS_SESSION_SECRET || AUTH_SECRET || "");
const supportTicketStore = SUPPORT_DATA_SECRET ? createSupportTicketStore({ dataDir: DATA_DIR, secret: SUPPORT_DATA_SECRET }) : null;
const platega = createPlatega({
  merchantId: process.env.PLATEGA_MERCHANT_ID,
  secret: process.env.PLATEGA_API_KEY,
  apiBase: process.env.PLATEGA_API_BASE,
  paymentMethod: process.env.PLATEGA_PAYMENT_METHOD
});
const PLATEGA_CHECKOUT_READY = BILLING_MODE === "platega" && platega.configured() && ONLINE_RECEIPTS_READY;
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
  throw new Error("Хранилище публикаций не настроено. Проверьте DATA_DIR и права записи сервиса.");
}

function telegramAlertsEnabled(chatId = TELEGRAM_CHAT_ID) {
  return Boolean(TELEGRAM_BOT_TOKEN && chatId);
}

function emailAlertsEnabled() {
  return Boolean(SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS && EMAIL_FROM);
}

function createMailer() {
  return nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_SECURE, auth: { user: SMTP_USER, pass: SMTP_PASS }, disableFileAccess: true, disableUrlAccess: true });
}

async function sendPasswordResetEmail(user, token) {
  if (!emailAlertsEnabled()) throw new Error("Email не настроен. Добавьте SMTP-параметры сервера.");
  const resetUrl = `${PUBLIC_BASE_URL || `http://localhost:${PORT}`}/?reset=${encodeURIComponent(token)}`;
  await createMailer().sendMail({
    from: EMAIL_FROM,
    to: user.email,
    subject: "ListingFlow — восстановление пароля",
    text: `Здравствуйте, ${user.name || "пользователь"}.\n\nЧтобы задать новый пароль, откройте ссылку:\n${resetUrl}\n\nСсылка действует ${PASSWORD_RESET_MINUTES} минут. Если вы не запрашивали восстановление, проигнорируйте письмо.`
  });
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

async function persistReleaseXml(slug, releaseId, xml) {
  if (!usesBlobStorage()) {
    const directory = path.join(FEEDS_DIR, "releases", slug);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${releaseId}.xml`), xml, { mode: 0o600, flag: "wx" });
    return;
  }
  await put(`feed-releases/${slug}/${releaseId}.xml`, xml, { access: "public", addRandomSuffix: false, contentType: "application/xml; charset=utf-8", cacheControlMaxAge: 31536000 });
}

async function readReleaseXml(feed, release) {
  if (usesBlobStorage()) {
    if (!release.url) throw new Error("Архив выпуска недоступен.");
    const response = await fetch(release.url, { cache: "no-store" });
    if (!response.ok) throw new Error("Архив выпуска недоступен.");
    return response.text();
  }
  const target = path.join(FEEDS_DIR, "releases", feed.slug, `${release.id}.xml`);
  if (!target.startsWith(path.join(FEEDS_DIR, "releases") + path.sep) || !fs.existsSync(target)) throw new Error("Архив выпуска не найден.");
  return fs.readFileSync(target, "utf8");
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, If-Match"
  });
  res.end(type.includes("json") ? JSON.stringify(body) : body);
}

function sendError(res, status, message) {
  send(res, status, { error: message });
}

function requestIp(req) {
  if (TRUST_PROXY) return String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
  return req.socket.remoteAddress || "unknown";
}

function enforceRateLimit(req, res, name, limit, windowMs) {
  const now = Date.now();
  const key = `${name}:${requestIp(req)}`;
  const current = rateBuckets.get(key);
  const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (rateBuckets.size > 10000) for (const [entry, value] of rateBuckets) if (value.resetAt <= now) rateBuckets.delete(entry);
  if (bucket.count <= limit) return false;
  res.setHeader("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
  sendError(res, 429, "Слишком много запросов. Повторите попытку позже.");
  return true;
}

function protectSensitiveRoute(req, res, pathname) {
  if (req.method !== "POST") return false;
  const policies = {
    "/api/auth-login": ["login", 8, 15 * 60 * 1000],
    "/api/auth-register": ["register", 5, 60 * 60 * 1000],
    "/api/auth/forgot-password": ["forgot", 4, 30 * 60 * 1000],
    "/api/auth/reset-password": ["reset", 8, 30 * 60 * 1000],
    "/api/support/tickets": ["support-ticket", 5, 60 * 60 * 1000],
    "/api/account/deletion-request": ["account-deletion", 2, 24 * 60 * 60 * 1000],
    "/api/billing/checkout": ["checkout", 12, 15 * 60 * 1000],
    "/api/billing/platega/callback": ["platega", 180, 60 * 1000]
  };
  const policy = policies[pathname];
  return policy ? enforceRateLimit(req, res, ...policy) : false;
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
    return ["client", "customer", "manager", "owner", "admin"].includes(session.role) ? session : null;
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
  if (["client", "customer"].includes(session.role)) {
    const user = await saasStore?.getUser(session.userId);
    return user && user.status !== "blocked" && user.sessionVersion === session.sessionVersion ? { ...session, user } : null;
  }
  if (session.role === "manager") {
    const staff = await saasStore?.getStaff(session.staffId);
    return staff && staff.status === "active" && staff.sessionVersion === session.sessionVersion ? { ...session, ...staff } : null;
  }
  return session;
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

function validateFeedPayload(payload) {
  const xml = String(payload.xml || "").trim();
  const invalid = message => { const error = new Error(message); error.status = 422; throw error; };
  if (!xml) invalid("XML фида пустой.");
  if (!xml.includes("<") || !xml.includes(">")) invalid("Содержимое не похоже на XML.");
  const platform = String(payload.platform || "cian").trim() || "cian";
  if (platform === "domclick") invalid("Постоянная публикация Домклик закрыта до подтверждения схемы агрегатором.");
  const wellFormed = XMLValidator.validate(xml);
  if (wellFormed !== true) invalid("Публикация остановлена: XML содержит синтаксическую ошибку.");
  const document = new XMLParser({ ignoreAttributes: false, trimValues: true, cdataPropName: "__cdata" }).parse(xml);
  const rows = platform === "avito" ? document?.Ads?.Ad : platform === "yandex" ? document?.["realty-feed"]?.offer : document?.feed?.object;
  const items = rows ? (Array.isArray(rows) ? rows : [rows]) : [];
  if (!items.length) invalid("Публикация остановлена: в XML не найдено объявлений.");
  const text = value => typeof value === "object" && value !== null ? String(value.__cdata || value["#text"] || "").trim() : String(value ?? "").trim();
  const missing = items.flatMap((item, index) => {
    const checks = platform === "avito"
      ? [["Id", item.Id], ["Description", item.Description], ["Address", item.Address], ["Price", item.Price]]
      : platform === "yandex"
        ? [["internal-id", item["@_internal-id"]], ["description", item.description], ["address", item.location?.address], ["price", item.price?.value]]
        : [["ExternalId", item.ExternalId], ["Description", item.Description], ["Address", item.Address], ["Price", item.BargainTerms?.Price]];
    return checks.filter(([, value]) => !text(value)).map(([name]) => `объявление ${index + 1}: ${name}`);
  });
  if (missing.length) invalid(`Публикация остановлена: обязательные поля не заполнены (${missing.slice(0, 5).join(", ")}).`);
  if (Number(payload.objectCount) !== items.length) invalid(`Публикация остановлена: в XML ${items.length} объявлений, а указано ${Number(payload.objectCount) || 0}.`);
  return {
    xml,
    platform,
    sourceUrl: String(payload.sourceUrl || "").trim(),
    name: String(payload.name || "").trim(),
    sourceType: String(payload.sourceType || "").trim(),
    sourceFeeds: Array.isArray(payload.sourceFeeds) ? payload.sourceFeeds.slice(0, 20).map(source => ({
      id: String(source?.id || "").slice(0, 120),
      url: String(source?.url || "").trim(),
      sourceType: String(source?.sourceType || "").trim() === "url" ? "url" : "file",
      autoSyncIntervalMinutes: normalizeAutoSyncInterval(source?.autoSyncIntervalMinutes),
      objectIds: [...new Set(Array.isArray(source?.objectIds) ? source.objectIds.map(value => String(value).trim()).filter(Boolean).slice(0, 100000) : [])],
      excludedObjectIds: [...new Set(Array.isArray(source?.excludedObjectIds) ? source.excludedObjectIds.map(value => String(value).trim()).filter(Boolean).slice(0, 100000) : [])]
    })) : []
  };
}

function normalizeAutoSyncInterval(value) {
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 60 && minutes <= 1440 ? minutes : 0;
}

async function saveFeed(req, payload, existingSlug = "", actor = null) {
  const data = validateFeedPayload(payload);
  const feeds = await readFeeds();
  const now = new Date().toISOString();
  const requestedSlug = existingSlug || payload.slug || data.name || `${data.platform}-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString("hex")}`;
  let slug = makeSlug(requestedSlug);
  const occupied = feeds.find(feed => feed.slug === slug);
  const existing = existingSlug ? occupied : undefined;
  if (APP_MODE === "external" && existingSlug && existing?.ownerId !== actor?.userId) {
    throw new Error("Фид не найден в вашем аккаунте.");
  }

  if (!existingSlug && occupied) {
    slug = `${slug}-${crypto.randomBytes(3).toString("hex")}`;
  }

  const releaseHistory = Array.isArray(existing?.releases) ? [...existing.releases] : [];
  let previousXml = "";
  if (existing) {
    try {
      if (usesBlobStorage() && existing.blobUrl) {
        const response = await fetch(existing.blobUrl, { cache: "no-store" });
        if (response.ok) previousXml = await response.text();
      } else {
        const previousFile = path.join(FEEDS_DIR, `${slug}.xml`);
        if (fs.existsSync(previousFile)) previousXml = fs.readFileSync(previousFile, "utf8");
      }
    } catch (error) {
      console.warn(`Could not read previous feed release ${slug}:`, error.message);
    }
  }
  if (previousXml && previousXml !== data.xml && !releaseHistory.some(release => release.checksum === crypto.createHash("sha256").update(previousXml).digest("hex"))) {
    const releaseId = crypto.randomUUID();
    const archived = await persistReleaseXml(slug, releaseId, previousXml);
    releaseHistory.unshift({ id: releaseId, version: Math.max(0, ...releaseHistory.map(item => Number(item.version) || 0)) + 1, createdAt: existing.updatedAt || existing.createdAt, objectCount: Number(existing.objectCount || 0), platform: existing.platform, checksum: crypto.createHash("sha256").update(previousXml).digest("hex"), ...(archived?.url ? { url: archived.url } : {}) });
  }

  const shouldAddRelease = !existing || previousXml !== data.xml;
  const blob = await persistFeedXml(slug, data.xml);
  const checksum = crypto.createHash("sha256").update(data.xml).digest("hex");
  if (shouldAddRelease) {
    const releaseId = crypto.randomUUID();
    const releaseRecord = await persistReleaseXml(slug, releaseId, data.xml);
    releaseHistory.unshift({ id: releaseId, version: Math.max(0, ...releaseHistory.map(item => Number(item.version) || 0)) + 1, createdAt: now, objectCount: Number(payload.objectCount || 0), platform: data.platform, checksum, ...(releaseRecord?.url ? { url: releaseRecord.url } : {}) });
  }

  const history = Array.isArray(existing?.history) ? existing.history : [];
  const version = Math.max(Number(existing?.publicationVersion) || 0, ...history.map(item => Number(item.version) || 0)) + 1;
  const historyEntry = {
    version,
    updatedAt: now,
    url: feedUrl(req, slug),
    objectCount: Number(payload.objectCount || 0),
    sourceUrl: data.sourceUrl,
    platform: data.platform
  };

  const record = {
    id: slug,
    slug,
    ownerId: APP_MODE === "external" ? actor?.userId : undefined,
    projectId: String(payload.projectId || existing?.projectId || ""),
    sourceId: String(payload.sourceId || existing?.sourceId || "all"),
    platform: data.platform,
    sourceUrl: data.sourceUrl,
    sourceType: data.sourceType,
    sourceFeeds: data.sourceFeeds.length ? data.sourceFeeds : existing?.sourceFeeds || [],
    autoSyncIntervalMinutes: normalizeAutoSyncInterval(payload.autoSyncIntervalMinutes),
    lastAutoSyncAt: existing?.lastAutoSyncAt || "",
    nextAutoSyncAt: existing?.nextAutoSyncAt || "",
    lastSuccessAt: now,
    nextRunAt: normalizeAutoSyncInterval(payload.autoSyncIntervalMinutes) ? new Date(Date.now() + normalizeAutoSyncInterval(payload.autoSyncIntervalMinutes) * 60 * 1000).toISOString() : "",
    autoSyncError: "",
    feedStale: false,
    syncFailureCount: 0,
    name: data.name || `${data.platform} feed`,
    objectCount: Number(payload.objectCount || 0),
    file: `feeds/${slug}.xml`,
    blobUrl: blob?.url || "",
    releases: releaseHistory.slice(0, 100),
    url: feedUrl(req, slug),
    updatedAt: now,
    createdAt: existing?.createdAt || now,
    history: [historyEntry, ...history].slice(0, 30),
    publicationVersion: version
  };

  await persistFeedRecord(record);
  if (APP_MODE === "external" && actor?.userId) await saasStore.recordAudit(actor.userId, existing ? "publish_update" : "publish", "feed", slug, { projectId: record.projectId, platform: record.platform, objectCount: record.objectCount, releaseCount: record.releases.length }).catch(error => console.error("Audit log:", error.message));
  return record;
}

let feedSyncRunning = false;

async function syncPublishedFeed(record) {
  const configuredSources = Array.isArray(record.sourceFeeds) && record.sourceFeeds.length
    ? record.sourceFeeds.filter(source => source.sourceType === "url" && source.url && normalizeAutoSyncInterval(source.autoSyncIntervalMinutes || record.autoSyncIntervalMinutes))
    : record.sourceUrl && record.sourceType === "url"
      ? [{ id: record.sourceId || "legacy-source", url: record.sourceUrl, sourceType: "url", objectIds: [], excludedObjectIds: [] }]
      : [];
  if (!configuredSources.length) return;
  const downloadedSources = await Promise.all(configuredSources.map(async source => ({ source, xml: await safeDownload(source.url) })));
  const filePath = path.join(FEEDS_DIR, `${record.slug}.xml`);
  if (!fs.existsSync(filePath)) throw new Error("Опубликованный XML не найден");
  const publishedXml = fs.readFileSync(filePath, "utf8");
  const managedIds = configuredSources.flatMap(source => Array.isArray(source.objectIds) ? source.objectIds : []);
  const excludedIds = configuredSources.flatMap(source => Array.isArray(source.excludedObjectIds) ? source.excludedObjectIds : []);
  const result = synchronizeFeed(publishedXml, downloadedSources.map(item => item.xml), {
    ...(managedIds.length ? { managedIds } : {}),
    excludedIds
  });
  if (!result.sourceCount) throw new Error("В источнике не найдены объявления с ценой");
  if (result.invalidSourceRecords) throw new Error(`В источнике есть объявления без ID или цены: ${result.invalidSourceRecords}`);
  if (result.publishedDuplicateIds.length) throw new Error(`В опубликованном фиде повторяются ID: ${result.publishedDuplicateIds.slice(0, 5).join(", ")}`);
  validateFeedPayload({ xml: result.xml, platform: record.platform, objectCount: result.outputCount });
  if (result.updated || result.added || result.removed) {
    const checksum = crypto.createHash("sha256").update(publishedXml).digest("hex");
    const history = Array.isArray(record.releases) ? [...record.releases] : [];
    if (!history.some(item => item.checksum === checksum)) {
      const id = crypto.randomUUID();
      await persistReleaseXml(record.slug, id, publishedXml);
      history.unshift({ id, version: Math.max(0, ...history.map(item => Number(item.version) || 0)) + 1, createdAt: record.updatedAt || record.createdAt, objectCount: record.objectCount, platform: record.platform, checksum });
    }
    const nextChecksum = crypto.createHash("sha256").update(result.xml).digest("hex");
    if (!history.some(item => item.checksum === nextChecksum)) {
      const id = crypto.randomUUID();
      await persistReleaseXml(record.slug, id, result.xml);
      history.unshift({ id, version: Math.max(0, ...history.map(item => Number(item.version) || 0)) + 1, createdAt: new Date().toISOString(), objectCount: result.outputCount, platform: record.platform, checksum: nextChecksum });
    }
    record.releases = history.slice(0, 100);
    const tempPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, result.xml);
    fs.renameSync(tempPath, filePath);
    const publicationHistory = Array.isArray(record.history) ? record.history : [];
    const publicationVersion = Math.max(Number(record.publicationVersion) || 0, ...publicationHistory.map(item => Number(item.version) || 0)) + 1;
    record.history = [{
      version: publicationVersion,
      updatedAt: new Date().toISOString(),
      url: record.url,
      objectCount: result.outputCount,
      sourceUrl: record.sourceUrl,
      platform: record.platform,
      automatic: true,
      changes: { prices: result.updated, added: result.added, removed: result.removed }
    }, ...publicationHistory].slice(0, 30);
    record.publicationVersion = publicationVersion;
  }
  const now = new Date();
  record.objectCount = result.outputCount;
  record.sourceFeeds = (record.sourceFeeds || []).map(source => {
    const downloaded = downloadedSources.find(item => item.source.id === source.id && item.source.url === source.url);
    return downloaded ? { ...source, objectIds: feedRecords(downloaded.xml).map(item => item.id).filter(Boolean) } : source;
  });
  record.lastAutoSyncAt = now.toISOString();
  record.nextAutoSyncAt = new Date(now.getTime() + record.autoSyncIntervalMinutes * 60 * 1000).toISOString();
  record.nextRunAt = record.nextAutoSyncAt;
  record.autoSyncError = "";
  record.lastSuccessAt = now.toISOString();
  record.feedStale = false;
  record.syncFailureCount = 0;
  record.updatedAt = now.toISOString();
  await persistFeedRecord(record);
  console.log(`Feed sync: ${record.slug}, prices: ${result.updated}/${result.checked}, objects: +${result.added}/-${result.removed}`);
}

async function runScheduledFeedSync() {
  if (feedSyncRunning || usesBlobStorage()) return;
  feedSyncRunning = true;
  try {
    const now = Date.now();
    const feeds = await readFeeds();
    for (const record of feeds) {
      const interval = normalizeAutoSyncInterval(record.autoSyncIntervalMinutes);
      const hasUrlSource = record.sourceType === "url" && record.sourceUrl
        || Array.isArray(record.sourceFeeds) && record.sourceFeeds.some(source => source.sourceType === "url" && source.url);
      if (!interval || !hasUrlSource) continue;
      const dueAt = new Date(record.nextRunAt || record.nextAutoSyncAt || record.updatedAt || 0).getTime();
      if (Number.isFinite(dueAt) && dueAt > now) continue;
      try {
        record.autoSyncIntervalMinutes = interval;
        await syncPublishedFeed(record);
      } catch (error) {
        const attemptedAt = new Date();
        record.lastAutoSyncAt = attemptedAt.toISOString();
        record.nextAutoSyncAt = new Date(attemptedAt.getTime() + interval * 60 * 1000).toISOString();
        record.autoSyncError = error.message || "Не удалось обновить источник";
        record.lastSyncErrorAt = attemptedAt.toISOString();
        record.syncFailureCount = Number(record.syncFailureCount || 0) + 1;
        const retryMinutes = Math.min(60, 2 ** Math.min(5, record.syncFailureCount - 1));
        record.nextRunAt = new Date(attemptedAt.getTime() + retryMinutes * 60 * 1000).toISOString();
        record.feedStale = !record.lastSuccessAt || attemptedAt.getTime() - new Date(record.lastSuccessAt).getTime() > interval * 2 * 60 * 1000;
        await persistFeedRecord(record);
        console.error(`Feed sync: ${record.slug}:`, record.autoSyncError);
      }
    }
  } finally {
    feedSyncRunning = false;
  }
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
    "ListingFlow: ошибка фида",
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
  return createMailer().sendMail({
    from: EMAIL_FROM,
    to: emailTo,
    subject: `ListingFlow: ошибка фида «${String(payload.name || "без названия").slice(0, 120)}»`,
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
  if (pathname.split('/').some(part=>part.startsWith('.')||part==='data'||part==='node_modules') || !['/','/feed-generator.html','/admin.html','/legal.html','/legal-documents.html','/cookie-consent.js','/cookie-consent.css','/layout-editor.js','/layout-editor.css','/listingflow-ui.css','/grovia-workspace.css','/monitor-client.js','/usage-guide.js','/usage-guide.css','/robots.txt'].includes(pathname) && !/\.(png|jpe?g|webp|svg|ico|woff2?)$/i.test(pathname)) return sendError(res,404,'Not found');
  const filePath = pathname === "/" ? path.join(ROOT, "feed-generator.html") : pathname === "/legal.html" ? path.join(ROOT, "legal-documents.html") : path.join(ROOT, pathname);
  if (!filePath.startsWith(ROOT)) return sendError(res, 403, "Forbidden");
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return sendError(res, 404, "Not found");
  const ext = path.extname(filePath).toLowerCase();
  if (pathname === "/legal.html") {
    const escapeHtml = value => String(value || "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    const email = escapeHtml(LEGAL.email);
    const emailHref = LEGAL.email ? `mailto:${encodeURIComponent(LEGAL.email)}` : "#";
    const html = fs.readFileSync(filePath, "utf8")
      .replaceAll("@@LEGAL_ADDRESS@@", escapeHtml(LEGAL.address || "не указан"))
      .replaceAll("@@LEGAL_PHONE@@", escapeHtml(LEGAL.phone || "не указан"))
      .replaceAll("@@LEGAL_EMAIL@@", email || "не указан")
      .replaceAll("@@LEGAL_EMAIL_HREF@@", emailHref)
      .replaceAll("@@LEGAL_NAME@@", escapeHtml(LEGAL.name))
      .replaceAll("@@LEGAL_INN@@", escapeHtml(LEGAL.inn))
      .replaceAll("@@LEGAL_OGRNIP@@", escapeHtml(LEGAL.ogrnip))
      .replaceAll("@@OFFER_VERSION@@", OFFER_VERSION)
      .replaceAll("@@PRIVACY_VERSION@@", PRIVACY_VERSION)
      .replaceAll("@@CONSENT_VERSION@@", CONSENT_VERSION)
      .replaceAll("@@BACKUP_RETENTION_DAYS@@", String(BACKUP_RETENTION_DAYS))
      .replaceAll('<span data-address></span>', escapeHtml(LEGAL.address || "не указан"))
      .replaceAll('<span data-phone></span>', escapeHtml(LEGAL.phone || "не указан"))
      .replaceAll('<a data-email></a>', `<a href="${emailHref}">${email || "не указан"}</a>`)
      .replace(/<script>fetch\('\/api\/public-config'\)[\s\S]*?<\/script>/g, "");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(html);
  }
  res.writeHead(200, {
    "Content-Type": mimeTypes[ext] || "application/octet-stream",
    "Cache-Control": "no-store"
  });
  fs.createReadStream(filePath).pipe(res);
}

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (protectSensitiveRoute(req, res, url.pathname)) return;

  if (req.method === "GET" && url.pathname === "/api/health") {
    const launch = APP_MODE === "external" ? inspectLaunchReadiness(process.env) : null;
    return send(res, 200, {
      ok: true,
      mode: APP_MODE,
      storage: usesBlobStorage() ? "vercel-blob" : "local",
      feedPublishingReady: usesBlobStorage() || !process.env.VERCEL,
      backgroundSyncReady: Boolean(APP_MODE === "external" && !usesBlobStorage() && canUseLocalStorage()),
      backgroundSyncIntervalMinutes: 1,
      telegramAlertsReady: telegramAlertsEnabled(),
      emailAlertsReady: emailAlertsEnabled(),
      billingMode: APP_MODE === "external" ? BILLING_MODE : null,
      billingReady: APP_MODE === "external" ? BILLING_MODE === "manual" || PLATEGA_CHECKOUT_READY : null,
      legalReady: APP_MODE === "external" ? LEGAL_PROFILE_READY : null,
      onlineReceiptsReady: APP_MODE === "external" ? ONLINE_RECEIPTS_READY : null,
      launchReady: launch?.ready ?? null,
      launchBlockers: launch?.blockers || [],
      launchWarnings: launch?.warnings || []
    });
  }

  if (req.method === "GET" && url.pathname === "/api/public-config") {
    return send(res, 200, { ...LEGAL, billingMode: BILLING_MODE, plan: APP_MODE === "external" ? PLAN : null });
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
      subscriptionReadOnly: actor?.user ? hasSubscriptionReadAccess(actor.user) && !isSubscriptionActive(actor.user) : false,
      subscriptionGraceUntil: actor?.user && hasSubscriptionReadAccess(actor.user) && !isSubscriptionActive(actor.user) ? subscriptionGraceUntil(actor.user) : null,
      plan: APP_MODE === "external" ? PLAN : null,
      billingMode: APP_MODE === "external" ? BILLING_MODE : null,
      supportEmail: APP_MODE === "external" ? LEGAL.email : null,
      legalReady: APP_MODE === "external" ? LEGAL_PROFILE_READY : null,
      onlineReceiptsReady: APP_MODE === "external" ? ONLINE_RECEIPTS_READY : null
    });
  }

  if (req.method === "POST" && url.pathname === "/api/auth-register") {
    if (APP_MODE !== "external" || !saasStore) return sendError(res, 404, "Регистрация недоступна.");
    if (!LEGAL_PROFILE_READY) return sendError(res, 503, "Регистрация временно недоступна: заполните реквизиты и контактный email в настройках сервиса.");
    const payload = await parseBody(req);
    try {
      const user = await saasStore.register({ ...payload, offerVersion: OFFER_VERSION, privacyVersion: PRIVACY_VERSION, consentVersion: CONSENT_VERSION });
      setSessionCookie(req, res, createSessionToken({ role: "client", userId: user.id, sessionVersion: user.sessionVersion }));
      return send(res, 201, { authenticated: true, user, subscriptionActive: false, plan: PLAN });
    } catch (error) {
      return sendError(res, /уже существует/.test(error.message) ? 409 : 400, error.message);
    }
  }

  if (req.method === "POST" && url.pathname === "/api/auth-login") {
    const payload = await parseBody(req);
    if (APP_MODE === "external") {
      if (!saasStore || !SESSION_SECRET) return sendError(res, 503, "Внешний контур ещё не настроен.");
      const email = normalizeEmail(payload.email || payload.username);
      if (email === EXTERNAL_ADMIN_EMAIL && EXTERNAL_ADMIN_PASSWORD && safeEqual(payload.password || "", EXTERNAL_ADMIN_PASSWORD)) {
        setSessionCookie(req, res, createSessionToken({ role: "owner", email }));
        return send(res, 200, { authenticated: true, role: "owner" });
      }
      const staff = await saasStore.authenticateStaff(email, payload.password || "");
      if (staff) {
        setSessionCookie(req, res, createSessionToken({ role: staff.role, staffId: staff.id, email: staff.email, name: staff.name, sessionVersion: staff.sessionVersion }));
        return send(res, 200, { authenticated: true, role: staff.role });
      }
      const user = await saasStore.authenticate(email, payload.password || "");
      if (!user) return sendError(res, 401, "Неверный email или пароль.");
      setSessionCookie(req, res, createSessionToken({ role: "client", userId: user.id, sessionVersion: user.sessionVersion }));
      return send(res, 200, { authenticated: true, role: "client" });
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

  if (req.method === "POST" && url.pathname === "/api/auth/forgot-password") {
    if (APP_MODE !== "external" || !saasStore) return sendError(res, 404, "Восстановление недоступно.");
    const payload = await parseBody(req);
    const reset = await saasStore.requestPasswordReset(payload.email, PASSWORD_RESET_MINUTES);
    if (reset) {
      try { await sendPasswordResetEmail(reset.user, reset.token); }
      catch (error) { console.error("Password reset email:", error.message); }
    }
    return send(res, 200, { sent: true, message: "Если аккаунт существует, письмо со ссылкой уже отправлено." });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/reset-password") {
    if (APP_MODE !== "external" || !saasStore) return sendError(res, 404, "Восстановление недоступно.");
    const payload = await parseBody(req);
    try { await saasStore.resetPassword(payload.token, payload.password); }
    catch (error) { return sendError(res, 400, error.message); }
    return send(res, 200, { reset: true });
  }

  if (req.method === "POST" && url.pathname === "/api/auth-logout") {
    if (APP_MODE === "external" && saasStore) {
      const actor = await currentActor(req);
      if (actor?.userId || actor?.staffId) await saasStore.revokeSessions({ userId: actor.userId, staffId: actor.staffId });
    }
    setSessionCookie(req, res, "", 0);
    return send(res, 200, { authenticated: false });
  }

  if (req.method === "GET" && url.pathname === "/api/public-feed") {
    return servePublicFeed(req, res, String(url.searchParams.get("slug") || ""));
  }

  if (req.method === "GET" && url.pathname === "/api/public-layout") {
    return servePublicLayout(req, res, String(url.searchParams.get("file") || ""));
  }

  if (req.method === "POST" && url.pathname === "/api/billing/platega/callback") {
    if (APP_MODE !== "external" || !saasStore || !platega.configured()) return sendError(res, 503, "Касса не настроена.");
    const payload = await parseBody(req);
    const transactionId = String(payload.id || payload.transactionId || "");
    const callbackAmount = payload.amount ?? payload.paymentDetails?.amount;
    const status = String(payload.status || "").toUpperCase();
    const logBase = { providerPaymentId: transactionId, amount: callbackAmount, status, source: "platega" };
    if (!platega.verifyNotification(req.headers)) {
      await saasStore.logPaymentEvent("callback_rejected", { ...logBase, status: "rejected", message: "Неверная подпись уведомления." });
      return sendError(res, 403, "Неверная подпись уведомления.");
    }
    await saasStore.logPaymentEvent("callback_received", { ...logBase, status: "received" });
    if (!transactionId) {
      await saasStore.logPaymentEvent("callback_rejected", { ...logBase, status: "rejected", message: "В уведомлении Platega нет идентификатора транзакции." });
      return sendError(res, 400, "Нет идентификатора транзакции.");
    }
    if (status !== "CONFIRMED") {
      if (transactionId && ["CANCELED", "CHARGEBACKED"].includes(status)) {
        try { await saasStore.setPaymentProviderStatus(transactionId, status, "Статус получен от Platega."); }
        catch (error) { await saasStore.logPaymentEvent("callback_error", { ...logBase, status: "error", message: error.message }); }
        return send(res, 200, { received: true });
      }
      await saasStore.logPaymentEvent("callback_rejected", { ...logBase, status: status || "unknown", message: "Платёж не подтверждён." });
      return send(res, 200, { received: true });
    }
    try { await saasStore.completePaymentByProviderTransactionId(transactionId, callbackAmount); }
    catch (error) { await saasStore.logPaymentEvent("callback_error", { ...logBase, status: "error", message: error.message }); throw error; }
    return send(res, 200, { received: true });
  }

  const actor = await currentActor(req);
  if (!actor) {
    return sendError(res, 401, "Требуется вход в сервис.");
  }

  if (APP_MODE === "external" && req.method === "GET" && url.pathname === "/api/projects") {
    if (!["client", "customer"].includes(actor.role)) return sendError(res, 403, "Раздел доступен клиентам.");
    const projectList = await saasStore.listProjects(actor.userId);
    const feeds = await readFeeds();
    const summaries = await Promise.all(projectList.map(async project => {
      const projectFeeds = feeds.filter(feed => feed.ownerId === actor.userId && feed.projectId === project.id);
      const saved = await projectStateStore.get(actor.userId, project.id);
      const editor = saved.state?.["feed-generator-cian-v2-" + project.id];
      const stale = projectFeeds.some(feed => feed.feedStale || (feed.nextAutoSyncAt && new Date(feed.nextAutoSyncAt).getTime() < Date.now() && feed.autoSyncError));
      return { ...project, summary: { sourceCount: Array.isArray(saved.state?.["feed-generator-sources-v1-" + project.id]) ? saved.state["feed-generator-sources-v1-" + project.id].length : 0, objectCount: Number(editor?.objects?.length || projectFeeds.at(0)?.objectCount || 0), lastReleaseAt: projectFeeds.map(feed => feed.updatedAt).sort().at(-1) || null, feedHealth: projectFeeds.some(feed => feed.autoSyncError) ? "error" : stale ? "stale" : projectFeeds.length ? "healthy" : "not_published", feeds: projectFeeds.map(feed => ({ id: feed.id, name: feed.name, url: feed.url, platform: feed.platform, objectCount: feed.objectCount, updatedAt: feed.updatedAt, lastSuccessAt: feed.lastSuccessAt || feed.lastAutoSyncAt || null, nextRunAt: feed.nextRunAt || feed.nextAutoSyncAt || null, stale: Boolean(feed.feedStale), autoSyncError: feed.autoSyncError || "" })) } };
    }));
    return send(res, 200, { projects: summaries, limit: actor.user.projectLimit || PLAN.minProjects });
  }

  if (APP_MODE === "external" && req.method === "POST" && url.pathname === "/api/projects") {
    if (!["client", "customer"].includes(actor.role)) return sendError(res, 403, "Раздел доступен клиентам.");
    const payload = await parseBody(req);
    try {
      return send(res, 201, await saasStore.createProject(actor.userId, payload.name));
    } catch (error) {
      const status = /доступно проектов/.test(error.message) ? 409 : /оплатите тариф/.test(error.message) ? 402 : 400;
      return sendError(res, status, error.message);
    }
  }

  if (APP_MODE === "external" && url.pathname === "/api/admin/support-tickets") {
    if (!["owner", "manager", "admin"].includes(actor.role)) return sendError(res, 403, "Требуются права администратора.");
    if (!supportTicketStore) return sendError(res, 503, "Хранилище обращений не настроено.");
    if (req.method === "GET") return send(res, 200, { tickets: await supportTicketStore.listAll() });
    if (req.method === "PUT") {
      const payload = await parseBody(req);
      try {
        const ticket = await supportTicketStore.update(String(payload.ticketId || ""), { status: String(payload.status || "") });
        if (ticket && saasStore) await saasStore.recordAudit(actor.email || actor.staffId || actor.role, "support_ticket_status_changed", "support_ticket", ticket.id, { number: ticket.number, status: ticket.status });
        return ticket ? send(res, 200, { ticket }) : sendError(res, 404, "Обращение не найдено.");
      } catch (error) { return sendError(res, 400, error.message); }
    }
    return sendError(res, 405, "Метод не поддерживается.");
  }

  if (url.pathname === "/api/support/tickets" && ["GET", "POST"].includes(req.method)) {
    const permitted = APP_MODE === "external" ? ["client", "customer"].includes(actor.role) : actor.role === "internal";
    if (!permitted) return sendError(res, 403, "Раздел доступен клиентам сервиса.");
    if (!supportTicketStore) return sendError(res, 503, "Техподдержка временно недоступна. Напишите на email сервиса.");
    if (req.method === "GET") return send(res, 200, { tickets: await supportTicketStore.listForUser(actor.userId || AUTH_USERNAME) });
    const payload = await parseBody(req);
    let projectName = "";
    const projectId = String(payload.projectId || "");
    if (APP_MODE === "external" && projectId) {
      const projects = await saasStore.listProjects(actor.userId);
      const project = projects.find(item => item.id === projectId);
      if (!project) return sendError(res, 403, "Выбранный проект недоступен.");
      projectName = project.name;
    } else if (APP_MODE === "internal" && projectId) {
      projectName = String(payload.projectName || "").trim().slice(0, 120);
    }
    try {
      const ticket = await supportTicketStore.create({
        userId: actor.userId || AUTH_USERNAME, projectId, projectName,
        contactName: payload.contactName || actor.user?.name || actor.name || "",
        contactEmail: payload.contactEmail || actor.user?.email || actor.email || "",
        category: String(payload.category || ""), title: String(payload.title || ""), description: String(payload.description || "")
      });
      if (APP_MODE === "external" && saasStore) await saasStore.recordAudit(actor.userId, "support_ticket_created", "support_ticket", ticket.id, { number: ticket.number, category: ticket.category });
      let notifiedByEmail = false;
      if (emailAlertsEnabled()) {
        try {
          await createMailer().sendMail({
            from: EMAIL_FROM, to: LEGAL.email, replyTo: ticket.contactEmail,
            subject: `ListingFlow · ${ticket.number}: ${ticket.title}`,
            text: `Новое обращение ${ticket.number}\nКлиент: ${ticket.contactName} <${ticket.contactEmail}>\nКатегория: ${ticket.category}\nПроект: ${ticket.projectName || "не выбран"}\n\n${ticket.description}`
          });
          notifiedByEmail = true;
        } catch { console.error("Support: не удалось отправить уведомление о новом обращении."); }
      }
      return send(res, 201, { ticket, notifiedByEmail });
    } catch (error) { return sendError(res, 400, error.message); }
  }

  if (APP_MODE === "external" && req.method === "GET" && url.pathname === "/api/account/export") {
    if (!["client", "customer"].includes(actor.role)) return sendError(res, 403, "Раздел доступен клиентам сервиса.");
    const projects = await saasStore.listProjects(actor.userId);
    const projectStates = [];
    for (const project of projects) {
      try { projectStates.push({ projectId: project.id, ...(await projectStateStore.get(actor.userId, project.id)) }); }
      catch (error) { projectStates.push({ projectId: project.id, error: "Состояние проекта временно недоступно для экспорта." }); }
    }
    const allFeeds = await readFeeds();
    const allLayouts = await readLayouts();
    const exportedAt = new Date().toISOString();
    const archive = {
      service: "ListingFlow", exportedAt, account: actor.user, projects, projectStates,
      payments: await saasStore.listPayments(actor.userId),
      feeds: allFeeds.filter(feed => feed.ownerId === actor.userId),
      layouts: allLayouts.filter(layout => layout.ownerId === actor.userId),
      monitoring: Object.fromEntries(projects.map(project => [project.id, monitor.read()[project.id] || []])),
      supportTickets: supportTicketStore ? await supportTicketStore.listForUser(actor.userId) : []
    };
    await saasStore.recordAudit(actor.userId, "export", "account", actor.userId, { exportedAt });
    res.setHeader("Content-Disposition", `attachment; filename="listingflow-data-${exportedAt.slice(0, 10)}.json"`);
    return send(res, 200, archive);
  }

  if (APP_MODE === "external" && req.method === "POST" && url.pathname === "/api/account/deletion-request") {
    if (!["client", "customer"].includes(actor.role)) return sendError(res, 403, "Раздел доступен клиентам сервиса.");
    if (!supportTicketStore) return sendError(res, 503, "Запрос временно нельзя зарегистрировать. Напишите на юридический email сервиса.");
    const ticket = await supportTicketStore.create({
      userId: actor.userId, contactName: actor.user.name || actor.user.company || "Пользователь ListingFlow",
      contactEmail: actor.user.email, category: "account", title: "Удаление аккаунта и персональных данных",
      description: "Пользователь запросил прекращение аккаунта и удаление персональных данных через личный кабинет. Требуется проверить обязательные сроки хранения платёжных документов и подтвердить исполнение по email."
    });
    await saasStore.recordAudit(actor.userId, "request_deletion", "account", actor.userId, { ticketId: ticket.id, number: ticket.number });
    if (emailAlertsEnabled()) {
      createMailer().sendMail({
        from: EMAIL_FROM, to: LEGAL.email, replyTo: actor.user.email,
        subject: `ListingFlow · ${ticket.number}: запрос на удаление аккаунта`,
        text: `Клиент ${actor.user.name || actor.user.company || actor.user.email} <${actor.user.email}> запросил удаление аккаунта и персональных данных. Номер обращения: ${ticket.number}.`
      }).catch(error => console.error("Account deletion email:", error.message));
    }
    return send(res, 202, { requested: true, ticket });
  }

  const projectStateMatch = APP_MODE === "external" ? url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/state$/i) : null;
  if (projectStateMatch && ["GET", "PUT"].includes(req.method)) {
    if (!["client", "customer"].includes(actor.role)) return sendError(res, 403, "Раздел доступен клиентам.");
    if (!await saasStore.hasProject(actor.userId, projectStateMatch[1])) return sendError(res, 403, "Проект недоступен.");
    if (req.method === "GET") {
      if (!hasSubscriptionReadAccess(actor.user)) return sendError(res, 402, "Льготный период закончился. Продлите тариф, чтобы открыть проекты.");
      const result = await projectStateStore.get(actor.userId, projectStateMatch[1]);
      res.setHeader("ETag", `"${result.revision}"`);
      return send(res, 200, result);
    }
    if (!await saasStore.ownsProject(actor.userId, projectStateMatch[1])) return sendError(res, 409, "Архивный проект доступен только для просмотра.");
    if (!isSubscriptionActive(actor.user)) return sendError(res, 402, "Для сохранения проекта оплатите тариф.");
    const payload = await parseBody(req);
    const expected = req.headers["if-match"]?.replace(/^\"|\"$/g, "");
    try {
      const saved = await projectStateStore.put(actor.userId, projectStateMatch[1], payload.state, expected === undefined ? undefined : Number(expected));
      await saasStore.recordAudit(actor.userId, "save", "project-state", projectStateMatch[1], { revision: saved.revision }).catch(error => console.error("Audit log:", error.message));
      res.setHeader("ETag", `"${saved.revision}"`);
      return send(res, 200, saved);
    } catch (error) {
      if (error.code === "REVISION_CONFLICT") return send(res, 409, { error: error.message, current: error.current });
      throw error;
    }
  }

  const releaseMatch = APP_MODE === "external" ? url.pathname.match(/^\/api\/feeds\/([a-z0-9а-яё-]+)\/releases(?:\/([a-f0-9-]+)\/rollback)?$/i) : null;
  if (releaseMatch && ["GET", "POST"].includes(req.method)) {
    if (!["client", "customer"].includes(actor.role)) return sendError(res, 403, "Раздел доступен клиентам.");
    const feeds = await readFeeds();
    const feed = feeds.find(item => item.slug === releaseMatch[1] && item.ownerId === actor.userId);
    if (!feed) return sendError(res, 404, "Фид не найден.");
    if (req.method === "GET" && !releaseMatch[2]) return send(res, 200, { releases: (feed.releases || []).map(({ id, version, createdAt, objectCount, platform, checksum }) => ({ id, version, createdAt, objectCount, platform, checksum })) });
    if (req.method !== "POST" || !releaseMatch[2]) return sendError(res, 405, "Метод не поддерживается.");
    if (!isSubscriptionActive(actor.user)) return sendError(res, 402, "Для отката выпуска продлите тариф.");
    const release = (feed.releases || []).find(item => item.id === releaseMatch[2]);
    if (!release) return sendError(res, 404, "Выпуск не найден.");
    const xml = await readReleaseXml(feed, release);
    const restored = await saveFeed(req, { ...feed, xml, platform: release.platform, objectCount: release.objectCount, projectId: feed.projectId, sourceUrl: feed.sourceUrl, sourceType: feed.sourceType }, feed.slug, actor);
    await saasStore.recordAudit(actor.userId, "rollback", "feed", feed.slug, { releaseId: release.id, version: release.version, projectId: feed.projectId }).catch(error => console.error("Audit log:", error.message));
    return send(res, 200, restored);
  }

  const projectDeleteMatch = APP_MODE === "external" ? url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)$/i) : null;
  if (projectDeleteMatch && req.method === "DELETE") {
    if (!["client", "customer"].includes(actor.role)) return sendError(res, 403, "Раздел доступен клиентам.");
    const deleted = await saasStore.deleteProject(actor.userId, projectDeleteMatch[1]);
    return send(res, deleted ? 200 : 404, deleted ? { archived: true } : { error: "Проект не найден." });
  }

  const restoreProjectMatch = APP_MODE === "external" ? url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/restore$/i) : null;
  if (restoreProjectMatch && req.method === "POST") {
    if (!["client", "customer"].includes(actor.role)) return sendError(res, 403, "Раздел доступен клиентам.");
    if (!isSubscriptionActive(actor.user)) return sendError(res, 402, "Для восстановления проекта продлите подписку.");
    try {
      const restored = await saasStore.restoreProject(actor.userId, restoreProjectMatch[1]);
      return send(res, restored ? 200 : 404, restored ? { restored: true } : { error: "Проект не найден." });
    } catch (error) {
      return sendError(res, 409, error.message);
    }
  }

  if (APP_MODE === "external" && req.method === "GET" && url.pathname === "/api/billing/payments") {
    if (!["client", "customer"].includes(actor.role)) return sendError(res, 403, "Раздел доступен клиентам.");
    return send(res, 200, { payments: await saasStore.listPayments(actor.userId), plan: PLAN, subscriptionUntil: actor.user.subscriptionUntil || null });
  }

  if (APP_MODE === "external" && req.method === "POST" && url.pathname === "/api/billing/checkout") {
    if (!["client", "customer"].includes(actor.role)) return sendError(res, 403, "Раздел доступен клиентам.");
    if (BILLING_MODE !== "platega") return sendError(res, 409, LEGAL.email ? `Онлайн-оплата пока не подключена. Для выставления счёта напишите на ${LEGAL.email}.` : "Онлайн-оплата пока не подключена. Обратитесь к администратору сервиса.");
    if (!PLATEGA_CHECKOUT_READY) return sendError(res, 503, ONLINE_RECEIPTS_READY ? "Platega ещё не настроена администратором." : "Онлайн-оплата временно отключена: настройка кассы и фискализации чеков ещё не подтверждена.");
    const payload = await parseBody(req);
    const payment = await saasStore.createPayment(actor.userId, payload.projectCount);
    try {
      const result = await platega.checkoutUrl({
        ...payment,
        email: actor.user.email,
        returnUrl: PUBLIC_BASE_URL || `https://${req.headers.host}/`,
        failedUrl: PUBLIC_BASE_URL || `https://${req.headers.host}/`
      });
      if (result.transactionId) await saasStore.attachPaymentProviderTransaction(payment.orderId, result.transactionId);
      return send(res, 201, { orderId: payment.orderId, transactionId: result.transactionId, url: result.url });
    } catch (error) {
      await saasStore.setPaymentProviderStatus(payment.orderId, "CANCELED", error.message);
      throw error;
    }
  }

  if (APP_MODE === "external" && url.pathname === "/api/admin") {
    if (!["owner", "manager", "admin"].includes(actor.role)) return sendError(res, 403, "Требуются права администратора.");
    if (req.method === "GET") return send(res, 200, await saasStore.adminSnapshot());
    if (req.method === "PUT") {
      const payload = await parseBody(req);
      return send(res, 200, await saasStore.updateUser(payload.userId, payload, actor.email || actor.staffId || actor.role));
    }
    return sendError(res, 405, "Метод не поддерживается");
  }

  const adminProjectMatch = APP_MODE === "external" ? url.pathname.match(/^\/api\/admin\/projects\/([a-f0-9-]+)$/i) : null;
  if (adminProjectMatch && req.method === "PUT") {
    if (!["owner", "manager", "admin"].includes(actor.role)) return sendError(res, 403, "Требуются права администратора.");
    const payload = await parseBody(req);
    return send(res, 200, await saasStore.updateProject(adminProjectMatch[1], payload, actor.email || actor.staffId || actor.role));
  }

  if (APP_MODE === "external" && url.pathname === "/api/admin/staff" && req.method === "POST") {
    if (!["owner", "admin"].includes(actor.role)) return sendError(res, 403, "Только владелец может управлять командой.");
    return send(res, 201, await saasStore.createStaff(await parseBody(req), actor.email || actor.role));
  }

  const adminStaffMatch = APP_MODE === "external" ? url.pathname.match(/^\/api\/admin\/staff\/([a-f0-9-]+)$/i) : null;
  if (adminStaffMatch && req.method === "DELETE") {
    if (!["owner", "admin"].includes(actor.role)) return sendError(res, 403, "Только владелец может управлять командой.");
    const deleted = await saasStore.deleteStaff(adminStaffMatch[1], actor.email || actor.role);
    return send(res, deleted ? 200 : 404, deleted ? { deleted: true } : { error: "Сотрудник не найден." });
  }

  if (APP_MODE === "external" && !["client", "customer"].includes(actor.role)) {
    return sendError(res, 403, "Раздел доступен клиентам.");
  }

  if (APP_MODE === "external" && ["client", "customer"].includes(actor.role) && !isSubscriptionActive(actor.user) && (!hasSubscriptionReadAccess(actor.user) || req.method !== "GET") && !["/api/billing/payments", "/api/projects", "/api/support/tickets", "/api/account/export", "/api/account/deletion-request"].includes(url.pathname)) {
    return sendError(res, 402, "Для работы с сервисом оплатите тариф от 5 000 ₽ в месяц.");
  }

  if (req.method === "GET" && url.pathname === "/api/feeds") {
    const feeds = await readFeeds();
    const ownedFeeds = APP_MODE === "external" ? feeds.filter(feed => feed.ownerId === actor.userId) : feeds;
    const projectId = String(url.searchParams.get("projectId") || "").trim();
    return send(res, 200, { feeds: projectId ? ownedFeeds.filter(feed => feed.projectId === projectId) : ownedFeeds });
  }

  if (url.pathname === '/api/monitor') {
    if(process.env.VERCEL)return sendError(res,503,'Серверное расписание требует постоянно работающего Node-процесса. Проверьте конфигурацию сервиса.');
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
    const xml = await safeDownload(sourceUrl);
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

  const historyDeleteMatch = url.pathname.match(/^\/api\/feeds\/([a-z0-9а-яё-]+)\/history\/(\d+)$/i);
  if (req.method === "DELETE" && historyDeleteMatch) {
    const feeds = await readFeeds();
    const record = feeds.find(feed => feed.slug === historyDeleteMatch[1]);
    if (!record || (APP_MODE === "external" && record.ownerId !== actor?.userId)) return sendError(res, 404, "Публикация не найдена.");
    const version = Number(historyDeleteMatch[2]);
    record.history = (Array.isArray(record.history) ? record.history : []).filter(item => Number(item.version) !== version);
    await persistFeedRecord(record);
    return send(res, 200, { history: record.history });
  }

  const renameFeedMatch = url.pathname.match(/^\/api\/feeds\/([a-z0-9а-яё-]+)\/name$/i);
  if (req.method === "PATCH" && renameFeedMatch) {
    const payload = await parseBody(req);
    const name = String(payload.name || "").trim().slice(0, 160);
    if (!name) return sendError(res, 400, "Название фида не может быть пустым.");
    const feeds = await readFeeds();
    const record = feeds.find(feed => feed.slug === renameFeedMatch[1]);
    if (!record || (APP_MODE === "external" && record.ownerId !== actor?.userId)) return sendError(res, 404, "Фид не найден.");
    record.name = name;
    record.updatedAt = new Date().toISOString();
    await persistFeedRecord(record);
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

  const remote = await safeDownloadBuffer(parsed.href, MAX_LAYOUT_BYTES);
  const headerContentType = String(remote.contentType || "").split(";")[0].trim().toLowerCase();
  const inferredContentType = imageContentTypeFromPath(parsed.href);
  const contentType = headerContentType.startsWith("image/") ? headerContentType : inferredContentType;
  if (!contentType.startsWith("image/")) {
    return sendError(res, 400, `Ссылка должна вести на изображение планировки. Источник вернул Content-Type: ${headerContentType || "не указан"}.`);
  }

  const bytes = remote.body;

  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  return res.end(bytes);
}

async function handleRequest(req, res) {
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' https://mc.yandex.ru; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://mc.yandex.ru; connect-src 'self' https://mc.yandex.ru https://yandex.ru https://app.platega.io; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://app.platega.io https://pay.platega.io");
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
    return sendError(res, error.status || 500, error.message || "Server error");
  }
}

if (require.main === module) {
  http.createServer(handleRequest).listen(PORT, HOST, () => {
    ensureStorage();
    console.log(`ListingFlow server is running on http://${HOST}:${PORT}`);
    const tick=()=>monitor.run().catch(error=>console.error('Monitor:',error.message));
    tick();setInterval(tick,60000).unref();
    const syncTick=()=>runScheduledFeedSync().catch(error=>console.error('Feed sync:',error.message));
    syncTick();setInterval(syncTick,60000).unref();
    pollTelegram();setInterval(pollTelegram,25000).unref();
  });
}

module.exports = handleRequest;
