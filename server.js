const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { del, list, put } = require("@vercel/blob");

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
  return crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("base64url");
}

function createSessionToken(username) {
  const payload = Buffer.from(JSON.stringify({
    username,
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000
  })).toString("base64url");
  return `${payload}.${signSession(payload)}`;
}

function isAuthenticated(req) {
  if (!AUTH_PASSWORD || !AUTH_SECRET) return false;
  const token = parseCookies(req)[AUTH_COOKIE] || "";
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !safeEqual(signature, signSession(payload))) return false;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return session.username === AUTH_USERNAME && Number(session.expiresAt) > Date.now();
  } catch {
    return false;
  }
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
        resolve(raw ? JSON.parse(raw) : {});
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

async function saveFeed(req, payload, existingSlug = "") {
  const data = validateFeedPayload(payload);
  const feeds = await readFeeds();
  const now = new Date().toISOString();
  const requestedSlug = existingSlug || payload.slug || data.name || `${data.platform}-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString("hex")}`;
  let slug = makeSlug(requestedSlug);
  const existing = feeds.find(feed => feed.slug === slug);

  if (!existingSlug && existing) {
    slug = `${slug}-${crypto.randomBytes(3).toString("hex")}`;
  }

  const blob = await persistFeedXml(slug, data.xml);

  const record = {
    id: slug,
    slug,
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

async function saveLayout(req, payload) {
  const data = validateLayoutPayload(payload);
  const now = new Date().toISOString();
  const baseSlug = makeSlug(`${data.name}-${data.rooms || ""}-${data.area || ""}`) || crypto.randomBytes(5).toString("hex");
  const id = `${baseSlug}-${crypto.randomBytes(3).toString("hex")}`;
  const fileName = `${id}${data.ext}`;
  const blob = await persistLayoutFile(fileName, data.bytes, data.contentType);
  const record = {
    id,
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

function serveStatic(req, res, pathname) {
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
      storage: usesBlobStorage() ? "vercel-blob" : "local",
      feedPublishingReady: usesBlobStorage() || !process.env.VERCEL
    });
  }

  if (req.method === "GET" && url.pathname === "/api/auth-session") {
    return send(res, 200, {
      authenticated: isAuthenticated(req),
      configured: Boolean(AUTH_PASSWORD && AUTH_SECRET)
    });
  }

  if (req.method === "POST" && url.pathname === "/api/auth-login") {
    if (!AUTH_PASSWORD || !AUTH_SECRET) {
      return sendError(res, 503, "Вход ещё не настроен на сервере.");
    }
    const payload = await parseBody(req);
    const usernameMatches = safeEqual(payload.username || "", AUTH_USERNAME);
    const passwordMatches = safeEqual(payload.password || "", AUTH_PASSWORD);
    if (!usernameMatches || !passwordMatches) {
      return sendError(res, 401, "Неверный логин или пароль.");
    }
    setSessionCookie(req, res, createSessionToken(AUTH_USERNAME));
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

  if (!isAuthenticated(req)) {
    return sendError(res, 401, "Требуется вход в сервис.");
  }

  if (req.method === "GET" && url.pathname === "/api/feeds") {
    return send(res, 200, { feeds: await readFeeds() });
  }

  if (req.method === "GET" && url.pathname === "/api/layouts") {
    return send(res, 200, { layouts: await readLayouts() });
  }

  if (req.method === "POST" && url.pathname === "/api/layouts") {
    const payload = await parseBody(req);
    const record = await saveLayout(req, payload);
    return send(res, 201, record);
  }

  const deleteLayoutMatch = url.pathname.match(/^\/api\/layouts\/([a-z0-9а-яё-]+)$/i);
  if (req.method === "DELETE" && deleteLayoutMatch) {
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
    const record = await saveFeed(req, payload);
    return send(res, 201, record);
  }

  if (req.method === "PUT" && url.pathname === "/api/feeds" && url.searchParams.get("slug")) {
    const payload = await parseBody(req);
    const record = await saveFeed(req, payload, url.searchParams.get("slug"));
    return send(res, 200, record);
  }

  const updateMatch = url.pathname.match(/^\/api\/feeds\/([a-z0-9а-яё-]+)$/i);
  if (req.method === "PUT" && updateMatch) {
    const payload = await parseBody(req);
    const record = await saveFeed(req, payload, updateMatch[1]);
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
    return send(res, 200, await response.text(), "application/xml; charset=utf-8");
  }

  const filePath = path.join(FEEDS_DIR, `${slug}.xml`);
  if (!fs.existsSync(filePath)) return sendError(res, 404, "Feed not found");
  res.writeHead(200, {
    "Content-Type": "application/xml; charset=utf-8",
    "Cache-Control": "public, max-age=60"
  });
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

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const publicFeedMatch = url.pathname.match(/^\/f\/([a-z0-9а-яё-]+)\.(php|xml)$/i);
    const publicLayoutMatch = url.pathname.match(/^\/layouts\/([^/]+)$/i);

    if (publicFeedMatch && req.method === "GET") {
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
  });
}

module.exports = handleRequest;
