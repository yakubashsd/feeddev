const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const FEEDS_DIR = path.join(DATA_DIR, "feeds");
const INDEX_FILE = path.join(DATA_DIR, "feeds-index.json");
const MAX_BODY_BYTES = 20 * 1024 * 1024;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

function ensureStorage() {
  fs.mkdirSync(FEEDS_DIR, { recursive: true });
  if (!fs.existsSync(INDEX_FILE)) fs.writeFileSync(INDEX_FILE, "[]\n");
}

function readIndex() {
  ensureStorage();
  try {
    const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeIndex(feeds) {
  ensureStorage();
  fs.writeFileSync(INDEX_FILE, `${JSON.stringify(feeds, null, 2)}\n`);
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(type.includes("json") ? JSON.stringify(body) : body);
}

function sendError(res, status, message) {
  send(res, status, { error: message });
}

function parseBody(req) {
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
    .replace(/\.xml$/i, "")
    .replace(/[^a-z0-9-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || crypto.randomBytes(5).toString("hex");
}

function feedUrl(req, slug) {
  const base = PUBLIC_BASE_URL || `http://${req.headers.host}`;
  return `${base}/f/${slug}.xml`;
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

function saveFeed(req, payload, existingSlug = "") {
  const data = validateFeedPayload(payload);
  const feeds = readIndex();
  const now = new Date().toISOString();
  const requestedSlug = existingSlug || payload.slug || data.name || `${data.platform}-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString("hex")}`;
  let slug = makeSlug(requestedSlug);
  const existing = feeds.find(feed => feed.slug === slug);

  if (!existingSlug && existing) {
    slug = `${slug}-${crypto.randomBytes(3).toString("hex")}`;
  }

  const filePath = path.join(FEEDS_DIR, `${slug}.xml`);
  fs.writeFileSync(filePath, data.xml);

  const record = {
    id: slug,
    slug,
    platform: data.platform,
    sourceUrl: data.sourceUrl,
    sourceType: data.sourceType,
    name: data.name || `${data.platform} feed`,
    objectCount: Number(payload.objectCount || 0),
    file: `feeds/${slug}.xml`,
    url: feedUrl(req, slug),
    updatedAt: now,
    createdAt: existing?.createdAt || now
  };

  const next = feeds.filter(feed => feed.slug !== slug);
  next.unshift(record);
  writeIndex(next);
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
    return send(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/feeds") {
    return send(res, 200, { feeds: readIndex() });
  }

  if (req.method === "POST" && url.pathname === "/api/feeds/import") {
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
    const record = saveFeed(req, payload);
    return send(res, 201, record);
  }

  const updateMatch = url.pathname.match(/^\/api\/feeds\/([a-z0-9а-яё-]+)$/i);
  if (req.method === "PUT" && updateMatch) {
    const payload = await parseBody(req);
    const record = saveFeed(req, payload, updateMatch[1]);
    return send(res, 200, record);
  }

  return sendError(res, 404, "API route not found");
}

async function handleRequest(req, res) {
  try {
    ensureStorage();
    const url = new URL(req.url, `http://${req.headers.host}`);
    const publicFeedMatch = url.pathname.match(/^\/f\/([a-z0-9а-яё-]+)\.xml$/i);

    if (publicFeedMatch && req.method === "GET") {
      const slug = publicFeedMatch[1];
      const filePath = path.join(FEEDS_DIR, `${slug}.xml`);
      if (!fs.existsSync(filePath)) return sendError(res, 404, "Feed not found");
      res.writeHead(200, {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "public, max-age=60"
      });
      return fs.createReadStream(filePath).pipe(res);
    }

    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return serveStatic(req, res, decodeURIComponent(url.pathname));
  } catch (error) {
    return sendError(res, 500, error.message || "Server error");
  }
}

http.createServer(handleRequest).listen(PORT, () => {
  ensureStorage();
  console.log(`FeedDev server is running on http://localhost:${PORT}`);
});
