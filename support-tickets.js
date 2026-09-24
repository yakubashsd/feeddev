const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CATEGORIES = new Set(["feed", "import", "publication", "billing", "account", "other"]);
const STATUSES = new Set(["new", "in_progress", "resolved"]);

function createSupportTicketStore({ dataDir, secret }) {
  if (!secret) throw new Error("Для защищённого хранилища обращений задайте секрет приложения.");
  const filePath = path.join(dataDir, "support-tickets.enc");
  const key = crypto.createHash("sha256").update(String(secret)).digest();
  let queue = Promise.resolve();

  function encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
  }
  function decrypt(value) {
    const bytes = Buffer.from(String(value).trim(), "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
  }
  function read() {
    if (!fs.existsSync(filePath)) return [];
    const parsed = decrypt(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  }
  function write(tickets) {
    fs.mkdirSync(dataDir, { recursive: true });
    const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(temporary, `${encrypt(tickets)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, filePath);
  }
  function mutate(callback) {
    const operation = queue.then(() => {
      const tickets = read();
      const result = callback(tickets);
      write(tickets);
      return result;
    });
    queue = operation.catch(() => {});
    return operation;
  }
  function publicTicket(ticket) {
    const { id, number, userId, projectId, projectName, contactName, contactEmail, category, title, description, status, createdAt, updatedAt, resolvedAt } = ticket;
    return { id, number, userId, projectId, projectName, contactName, contactEmail, category, title, description, status, createdAt, updatedAt, resolvedAt };
  }
  return {
    listForUser(userId) {
      return queue.then(() => read().filter(ticket => ticket.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicTicket));
    },
    listAll() {
      return queue.then(() => read().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicTicket));
    },
    create({ userId, projectId = "", projectName = "", contactName, contactEmail, category, title, description }) {
      const normalizedEmail = String(contactEmail || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) throw new Error("Укажите корректный email для ответа.");
      if (!CATEGORIES.has(category)) throw new Error("Выберите категорию обращения.");
      const cleanTitle = String(title || "").trim().slice(0, 160);
      const cleanDescription = String(description || "").trim().slice(0, 5000);
      if (cleanTitle.length < 4) throw new Error("Кратко опишите проблему (не менее 4 символов).");
      if (cleanDescription.length < 20) throw new Error("Добавьте подробности (не менее 20 символов).");
      return mutate(tickets => {
        const now = new Date().toISOString();
        const id = crypto.randomUUID();
        const ticket = {
          id,
          number: `LF-${now.slice(2, 10).replaceAll("-", "")}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`,
          userId: String(userId || "local"), projectId: String(projectId || "").slice(0, 80), projectName: String(projectName || "").trim().slice(0, 120),
          contactName: String(contactName || "").trim().slice(0, 120) || "Пользователь ListingFlow",
          contactEmail: normalizedEmail, category, title: cleanTitle, description: cleanDescription,
          status: "new", createdAt: now, updatedAt: now, resolvedAt: null
        };
        tickets.unshift(ticket);
        if (tickets.length > 5000) tickets.length = 5000;
        return publicTicket(ticket);
      });
    },
    update(id, { status }) {
      if (!STATUSES.has(status)) throw new Error("Неизвестный статус обращения.");
      return mutate(tickets => {
        const ticket = tickets.find(item => item.id === id);
        if (!ticket) return null;
        ticket.status = status;
        ticket.updatedAt = new Date().toISOString();
        ticket.resolvedAt = status === "resolved" ? ticket.updatedAt : null;
        return publicTicket(ticket);
      });
    }
  };
}

module.exports = { createSupportTicketStore };
