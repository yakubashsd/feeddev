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
const { PLAN, createSaasStore, isSubscriptionActive, normalizeEmail } = require("./saas-store");
const { createProjectStateStore } = require("./project-state-store");
const { createFreeKassa } = require("./freekassa");
const { synchronizePrices } = require("./feed-sync");
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
const BILLING_MODE = String(process.env.BILLING_MODE || "manual").toLowerCase() === "freekassa" ? "freekassa" : "manual";
const LEGAL = {
  name: String(process.env.LEGAL_NAME || "ИП Якубаш С.Д."),
  inn: String(process.env.LEGAL_INN || "720326517332"),
  ogrnip: String(process.env.LEGAL_OGRNIP || "326723200087150"),
  address: String(process.env.LEGAL_ADDRESS || ""),
  email: String(process.env.LEGAL_EMAIL || EMAIL_FROM.match(/[\w.+-]+@[\w.-]+/)?.[0] || ""),
  phone: String(process.env.LEGAL_PHONE || "")
};
const rateBuckets = new Map();
const MONITOR_INTERVAL_MINUTES = 12 * 60;
const telegramLinks = require('./telegram-link').createTelegramLinks({file:path.join(DATA_DIR,'telegram-links.json')});
const saasStore = APP_MODE === "external" && process.env.SAAS_DATA_SECRET
  ? createSaasStore({ dataDir: DATA_DIR, secret: process.env.SAAS_DATA_SECRET })
  : null;
const projectStateStore = APP_MODE === "external" && process.env.SAAS_DATA_SECRET
  ? createProjectStateStore({ dataDir: DATA_DIR, secret: process.env.SAAS_DATA_SECRET })
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

async function deleteProjectAssets(userId, projectId) {
  const feeds = await readFeeds();
  const projectFeeds = feeds.filter(feed => feed.ownerId === userId && feed.projectId === projectId);
  if (!usesBlobStorage()) {
    for (const feed of projectFeeds) {
      const filePath = path.join(FEEDS_DIR, `${feed.slug}.xml`);
      if (filePath.startsWith(FEEDS_DIR) && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    if (projectFeeds.length) writeLocalIndex(feeds.filter(feed => !projectFeeds.includes(feed)));
  } else {
    await Promise.allSettled(projectFeeds.flatMap(feed => [del(`feeds/${feed.slug}.xml`), del(`feed-records/${feed.slug}.json`)]));
  }
  const layouts = await readLayouts();
  for (const layout of layouts.filter(item => item.ownerId === userId && item.projectId === projectId)) await deleteLayoutRecord(layout.id);
  if (!process.env.VERCEL) monitor.replace(projectId, []);
  telegramLinks.disconnect(userId, projectId);
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
    "/api/billing/checkout": ["checkout", 12, 15 * 60 * 1000],
    "/api/billing/freekassa/callback": ["freekassa", 180, 60 * 1000]
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
  if (!xml) throw new Error("XML фида пустой.");
  if (!xml.includes("<") || !xml.includes(">")) throw new Error("Содержимое не похоже на XML.");
  const platform = String(payload.platform || "cian").trim() || "cian";
  return {
    xml,
    platform,
    sourceUrl: String(payload.sourceUrl || "").trim(),
    name: String(payload.name || "").trim(),
    sourceType: String(payload.sourceType || "").trim()
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
    autoSyncIntervalMinutes: normalizeAutoSyncInterval(payload.autoSyncIntervalMinutes),
    lastAutoSyncAt: existing?.lastAutoSyncAt || "",
    nextAutoSyncAt: existing?.nextAutoSyncAt || "",
    autoSyncError: "",
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

let feedSyncRunning = false;

async function syncPublishedFeed(record) {
  if (!record.sourceUrl || record.sourceType !== "url") return;
  const sourceXml = await safeDownload(record.sourceUrl);
  const filePath = path.join(FEEDS_DIR, `${record.slug}.xml`);
  if (!fs.existsSync(filePath)) throw new Error("Опубликованный XML не найден");
  const publishedXml = fs.readFileSync(filePath, "utf8");
  const result = synchronizePrices(publishedXml, sourceXml);
  if (!result.sourceCount) throw new Error("В источнике не найдены объявления с ценой");
  if (result.updated) {
    const tempPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, result.xml);
    fs.renameSync(tempPath, filePath);
  }
  const now = new Date();
  record.lastAutoSyncAt = now.toISOString();
  record.nextAutoSyncAt = new Date(now.getTime() + record.autoSyncIntervalMinutes * 60 * 1000).toISOString();
  record.autoSyncError = "";
  record.updatedAt = now.toISOString();
  await persistFeedRecord(record);
  console.log(`Feed sync: ${record.slug}, prices updated: ${result.updated}/${result.checked}`);
}

async function runScheduledFeedSync() {
  if (feedSyncRunning || usesBlobStorage()) return;
  feedSyncRunning = true;
  try {
    const now = Date.now();
    const feeds = await readFeeds();
    for (const record of feeds) {
      const interval = normalizeAutoSyncInterval(record.autoSyncIntervalMinutes);
      if (!interval || !record.sourceUrl || record.sourceType !== "url") continue;
      const dueAt = new Date(record.nextAutoSyncAt || record.updatedAt || 0).getTime();
      if (Number.isFinite(dueAt) && dueAt > now) continue;
      try {
        record.autoSyncIntervalMinutes = interval;
        await syncPublishedFeed(record);
      } catch (error) {
        const attemptedAt = new Date();
        record.lastAutoSyncAt = attemptedAt.toISOString();
        record.nextAutoSyncAt = new Date(attemptedAt.getTime() + interval * 60 * 1000).toISOString();
        record.autoSyncError = error.message || "Не удалось обновить источник";
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
  if (pathname.split('/').some(part=>part.startsWith('.')||part==='data'||part==='node_modules') || !['/','/feed-generator.html','/admin.html','/legal.html','/layout-editor.js','/layout-editor.css','/listingflow-ui.css','/monitor-client.js','/robots.txt'].includes(pathname) && !/\.(png|jpe?g|webp|svg|ico|woff2?)$/i.test(pathname)) return sendError(res,404,'Not found');
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
  if (protectSensitiveRoute(req, res, url.pathname)) return;

  if (req.method === "GET" && url.pathname === "/api/health") {
    return send(res, 200, {
      ok: true,
      mode: APP_MODE,
      storage: usesBlobStorage() ? "vercel-blob" : "local",
      feedPublishingReady: usesBlobStorage() || !process.env.VERCEL,
      telegramAlertsReady: telegramAlertsEnabled(),
      emailAlertsReady: emailAlertsEnabled(),
      billingMode: APP_MODE === "external" ? BILLING_MODE : null,
      billingReady: APP_MODE === "external" ? BILLING_MODE === "manual" || freeKassa.configured() : null,
      legalReady: APP_MODE === "external" ? Boolean(LEGAL.name && LEGAL.inn && LEGAL.ogrnip && LEGAL.address && LEGAL.email) : null
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
      plan: APP_MODE === "external" ? PLAN : null,
      billingMode: APP_MODE === "external" ? BILLING_MODE : null,
      supportEmail: APP_MODE === "external" ? LEGAL.email : null
    });
  }

  if (req.method === "POST" && url.pathname === "/api/auth-register") {
    if (APP_MODE !== "external" || !saasStore) return sendError(res, 404, "Регистрация недоступна.");
    const payload = await parseBody(req);
    const user = await saasStore.register(payload);
    setSessionCookie(req, res, createSessionToken({ role: "client", userId: user.id, sessionVersion: user.sessionVersion }));
    return send(res, 201, { authenticated: true, user, subscriptionActive: false, plan: PLAN });
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
    const orderId = String(payload.MERCHANT_ORDER_ID || payload.order_id || "");
    const logBase = { orderId, providerPaymentId: payload.intid || payload.INTID || "", amount: payload.AMOUNT || payload.amount, source: "freekassa" };
    if (!freeKassa.verifyNotification(payload)) {
      await saasStore.logPaymentEvent("callback_rejected", { ...logBase, status: "rejected", message: "Неверная подпись уведомления." });
      return sendError(res, 403, "Неверная подпись уведомления.");
    }
    await saasStore.logPaymentEvent("callback_received", { ...logBase, status: "received" });
    try { await saasStore.completePayment(orderId, logBase.providerPaymentId, logBase.amount); }
    catch (error) { await saasStore.logPaymentEvent("callback_error", { ...logBase, status: "error", message: error.message }); throw error; }
    return send(res, 200, "YES", "text/plain; charset=utf-8");
  }

  const actor = await currentActor(req);
  if (!actor) {
    return sendError(res, 401, "Требуется вход в сервис.");
  }

  if (APP_MODE === "external" && req.method === "GET" && url.pathname === "/api/projects") {
    if (!["client", "customer"].includes(actor.role)) return sendError(res, 403, "Раздел доступен клиентам.");
    return send(res, 200, { projects: await saasStore.listProjects(actor.userId), limit: actor.user.projectLimit || PLAN.minProjects });
  }

  if (APP_MODE === "external" && req.method === "POST" && url.pathname === "/api/projects") {
    if (!["client", "customer"].includes(actor.role)) return sendError(res, 403, "Раздел доступен клиентам.");
    const payload = await parseBody(req);
    return send(res, 201, await saasStore.createProject(actor.userId, payload.name));
  }

  const projectStateMatch = APP_MODE === "external" ? url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/state$/i) : null;
  if (projectStateMatch && ["GET", "PUT"].includes(req.method)) {
    if (!["client", "customer"].includes(actor.role)) return sendError(res, 403, "Раздел доступен клиентам.");
    if (!await saasStore.ownsProject(actor.userId, projectStateMatch[1])) return sendError(res, 403, "Проект недоступен.");
    if (req.method === "GET") return send(res, 200, await projectStateStore.get(actor.userId, projectStateMatch[1]));
    if (!isSubscriptionActive(actor.user)) return sendError(res, 402, "Для сохранения проекта оплатите тариф.");
    const payload = await parseBody(req);
    return send(res, 200, await projectStateStore.put(actor.userId, projectStateMatch[1], payload.state));
  }

  const projectDeleteMatch = APP_MODE === "external" ? url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)$/i) : null;
  if (projectDeleteMatch && req.method === "DELETE") {
    if (!["client", "customer"].includes(actor.role)) return sendError(res, 403, "Раздел доступен клиентам.");
    const deleted = await saasStore.deleteProject(actor.userId, projectDeleteMatch[1]);
    if (deleted) {
      await projectStateStore.remove(actor.userId, projectDeleteMatch[1]);
      await deleteProjectAssets(actor.userId, projectDeleteMatch[1]);
    }
    return send(res, deleted ? 200 : 404, deleted ? { deleted: true } : { error: "Проект не найден." });
  }

  if (APP_MODE === "external" && req.method === "POST" && url.pathname === "/api/billing/checkout") {
    if (!["client", "customer"].includes(actor.role)) return sendError(res, 403, "Раздел доступен клиентам.");
    if (BILLING_MODE !== "freekassa") return sendError(res, 409, LEGAL.email ? `Онлайн-оплата пока не подключена. Для выставления счёта напишите на ${LEGAL.email}.` : "Онлайн-оплата пока не подключена. Обратитесь к администратору сервиса.");
    if (!freeKassa.configured()) return sendError(res, 503, "FreeKassa ещё не настроена администратором.");
    const payload = await parseBody(req);
    const payment = await saasStore.createPayment(actor.userId, payload.projectCount);
    return send(res, 201, { orderId: payment.orderId, url: freeKassa.checkoutUrl({ ...payment, email: actor.user.email }) });
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

  if (APP_MODE === "external" && ["client", "customer"].includes(actor.role) && !isSubscriptionActive(actor.user)) {
    return sendError(res, 402, "Для работы с сервисом оплатите тариф от 7 500 ₽ в месяц.");
  }

  if (req.method === "GET" && url.pathname === "/api/feeds") {
    const feeds = await readFeeds();
    return send(res, 200, { feeds: APP_MODE === "external" ? feeds.filter(feed => feed.ownerId === actor.userId) : feeds });
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
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' https://mc.yandex.ru; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://mc.yandex.ru; connect-src 'self' https://mc.yandex.ru https://yandex.ru; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://pay.freekassa.ru");
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
