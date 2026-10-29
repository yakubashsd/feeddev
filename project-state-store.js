const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function createProjectStateStore({ dataDir, secret }) {
  if (!secret) throw new Error("Для хранилища проектов задайте SAAS_DATA_SECRET.");
  const root = path.join(dataDir, "project-state");
  const queues = new Map();
  const cache = new Map();
  const encryptionKey = crypto.createHash("sha256").update(String(secret)).digest();

  function key() { return encryptionKey; }
  function file(userId, projectId) {
    if (!/^[a-f0-9-]{20,}$/i.test(userId) || !/^[a-f0-9-]{20,}$/i.test(projectId)) throw new Error("Некорректный идентификатор проекта.");
    return path.join(root, `${userId}-${projectId}.enc`);
  }
  function revisionFile(target) { return `${target}.meta`; }

  function stamp(target) {
    try {
      const stat = fs.statSync(target);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "missing";
    }
  }

  function readRecord(target) {
    const currentStamp = stamp(target);
    const cached = cache.get(target);
    if (cached?.stamp === currentStamp) return cached.record;
    if (currentStamp === "missing") {
      cache.delete(target);
      return null;
    }
    const record = decrypt(fs.readFileSync(target, "utf8"));
    cache.set(target, { stamp: currentStamp, record });
    return record;
  }
  function encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
  }
  function decrypt(value) {
    const bytes = Buffer.from(String(value).trim(), "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
  }
  async function get(userId, projectId) {
    const target = file(userId, projectId);
    const record = readRecord(target);
    if (!record) return { state: null, updatedAt: null, revision: 0 };
    return { state: record.state || {}, updatedAt: record.updatedAt || null, revision: Number(record.revision || 1) };
  }
  async function getRevision(userId, projectId) {
    const target = file(userId, projectId);
    try {
      const meta = JSON.parse(fs.readFileSync(revisionFile(target), "utf8"));
      return { revision: Number(meta.revision || 0), updatedAt: meta.updatedAt || null };
    } catch {
      const record = readRecord(target);
      return { revision: Number(record?.revision || 0), updatedAt: record?.updatedAt || null };
    }
  }
  function put(userId, projectId, state, expectedRevision) {
    if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("Некорректное состояние проекта.");
    const target = file(userId, projectId);
    const previous = queues.get(target) || Promise.resolve();
    const operation = previous.then(async () => {
      fs.mkdirSync(root, { recursive: true });
      const current = readRecord(target);
      const currentRevision = Number(current?.revision || 0);
      if (expectedRevision !== undefined && Number(expectedRevision) !== currentRevision) {
        const conflict = new Error("Состояние проекта уже изменилось на другом устройстве.");
        conflict.code = "REVISION_CONFLICT";
        conflict.current = { state: current?.state || null, updatedAt: current?.updatedAt || null, revision: currentRevision };
        throw conflict;
      }
      const record = { version: 2, revision: currentRevision + 1, userId, projectId, state, updatedAt: new Date().toISOString() };
      // Publish the encrypted snapshot first, then its small revision marker.
      // This ordering prevents a reader from observing a new ETag while still
      // receiving the previous snapshot if the process stops mid-write.
      const temp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      fs.writeFileSync(temp, `${encrypt(record)}\n`, { mode: 0o600 });
      fs.renameSync(temp, target);
      const metaTarget = revisionFile(target);
      const metaTemp = `${metaTarget}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      fs.writeFileSync(metaTemp, `${JSON.stringify({ revision: record.revision, updatedAt: record.updatedAt })}\n`, { mode: 0o600 });
      fs.renameSync(metaTemp, metaTarget);
      cache.set(target, { stamp: stamp(target), record });
      return { updatedAt: record.updatedAt, revision: record.revision };
    });
    queues.set(target, operation.catch(() => {}));
    return operation;
  }
  async function remove(userId, projectId) {
    const target = file(userId, projectId);
    if (!fs.existsSync(target)) return false;
    fs.unlinkSync(target);
    try { fs.unlinkSync(revisionFile(target)); } catch {}
    cache.delete(target);
    return true;
  }
  return { get, getRevision, put, remove };
}

module.exports = { createProjectStateStore };
