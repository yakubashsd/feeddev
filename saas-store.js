const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { get, put } = require("@vercel/blob");

const PLAN = Object.freeze({ code: "projects", name: "Проекты", unitAmount: 7500, days: 30, minProjects: 1, maxProjects: 10 });
const FILE_NAME = "saas-store.enc";
const BLOB_PATH = "private/saas-store.enc";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function emptyState() {
  return { version: 1, users: [], projects: [], payments: [] };
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function deriveKey(secret) {
  return crypto.createHash("sha256").update(String(secret)).digest();
}

function encrypt(value, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

function decrypt(value, secret) {
  const bytes = Buffer.from(String(value).trim(), "base64");
  const iv = bytes.subarray(0, 12);
  const tag = bytes.subarray(12, 28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(secret), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return `${salt}:${crypto.scryptSync(String(password), salt, 64).toString("hex")}`;
}

function verifyPassword(password, stored) {
  const [salt, expectedHex] = String(stored || "").split(":");
  if (!salt || !expectedHex) return false;
  const actual = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    projectLimit: Number(user.projectLimit || 1),
    subscriptionUntil: user.subscriptionUntil || null,
    createdAt: user.createdAt
  };
}

function createSaasStore({ dataDir, secret, blobEnabled = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN) }) {
  if (!secret) throw new Error("Для внешнего режима задайте SAAS_DATA_SECRET.");
  const filePath = path.join(dataDir, FILE_NAME);

  async function read() {
    try {
      if (!blobEnabled()) {
        if (!fs.existsSync(filePath)) return emptyState();
        return decrypt(fs.readFileSync(filePath, "utf8"), secret);
      }
      const result = await get(BLOB_PATH, { access: "private", useCache: false });
      if (!result?.stream) return emptyState();
      return decrypt(await new Response(result.stream).text(), secret);
    } catch (error) {
      if (error.code === "ENOENT") return emptyState();
      throw error;
    }
  }

  async function write(state) {
    const encoded = encrypt(state, secret);
    if (!blobEnabled()) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(filePath, `${encoded}\n`, { mode: 0o600 });
      return;
    }
    await put(BLOB_PATH, encoded, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "text/plain; charset=utf-8"
    });
  }

  async function register({ email, password, name }) {
    email = normalizeEmail(email);
    name = String(name || "").trim();
    if (!EMAIL_RE.test(email)) throw new Error("Укажите корректный email.");
    if (String(password).length < 8) throw new Error("Пароль должен содержать не менее 8 символов.");
    if (!name) throw new Error("Укажите имя.");
    const state = await read();
    if (state.users.some(user => user.email === email)) throw new Error("Аккаунт с таким email уже существует.");
    const now = new Date().toISOString();
    const user = {
      id: crypto.randomUUID(), email, name: name.slice(0, 120), passwordHash: hashPassword(password),
      status: "pending_payment", projectLimit: 1, subscriptionUntil: null, createdAt: now, updatedAt: now
    };
    state.users.push(user);
    await write(state);
    return publicUser(user);
  }

  async function authenticate(email, password) {
    const state = await read();
    const user = state.users.find(item => item.email === normalizeEmail(email));
    if (!user || user.status === "blocked" || !verifyPassword(password, user.passwordHash)) return null;
    return publicUser(user);
  }

  async function getUser(userId) {
    const state = await read();
    const user = state.users.find(item => item.id === userId);
    return user ? publicUser(user) : null;
  }

  async function listProjects(userId) {
    const state = await read();
    return state.projects.filter(project => project.userId === userId).map(({ userId: _, ...project }) => project);
  }

  async function createProject(userId, name) {
    name = String(name || "").trim();
    if (!name) throw new Error("Укажите название проекта.");
    const state = await read();
    const user = state.users.find(item => item.id === userId);
    if (!user || user.status === "blocked") throw new Error("Аккаунт недоступен.");
    if (!isSubscriptionActive(user)) throw new Error("Сначала оплатите тариф.");
    const projectLimit = Math.min(PLAN.maxProjects, Math.max(PLAN.minProjects, Number(user.projectLimit || 1)));
    if (state.projects.filter(project => project.userId === userId).length >= projectLimit) {
      throw new Error(`На тарифе доступно проектов: ${projectLimit}.`);
    }
    const project = { id: crypto.randomUUID(), userId, name: name.slice(0, 100), createdAt: new Date().toISOString() };
    state.projects.push(project);
    await write(state);
    const { userId: _, ...result } = project;
    return result;
  }

  async function deleteProject(userId, projectId) {
    const state = await read();
    const before = state.projects.length;
    state.projects = state.projects.filter(project => !(project.id === projectId && project.userId === userId));
    if (state.projects.length === before) return false;
    await write(state);
    return true;
  }

  async function ownsProject(userId, projectId) {
    const state = await read();
    return state.projects.some(project => project.userId === userId && project.id === projectId);
  }

  async function createPayment(userId, projectCount = 1) {
    const state = await read();
    if (!state.users.some(user => user.id === userId && user.status !== "blocked")) throw new Error("Аккаунт не найден.");
    projectCount = Number(projectCount);
    if (!Number.isInteger(projectCount) || projectCount < PLAN.minProjects || projectCount > PLAN.maxProjects) {
      throw new Error(`Выберите от ${PLAN.minProjects} до ${PLAN.maxProjects} проектов.`);
    }
    const payment = {
      id: crypto.randomUUID(), orderId: `FD-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
      userId, projectCount, amount: PLAN.unitAmount * projectCount, currency: "RUB", status: "pending", createdAt: new Date().toISOString(), paidAt: null
    };
    state.payments.push(payment);
    await write(state);
    return payment;
  }

  async function completePayment(orderId, providerPaymentId = "", notifiedAmount) {
    const state = await read();
    const payment = state.payments.find(item => item.orderId === orderId);
    if (!payment) throw new Error("Заказ не найден.");
    if (Number(notifiedAmount) !== payment.amount) throw new Error("Сумма платежа не совпадает с заказом.");
    if (payment.status === "paid") return payment;
    const user = state.users.find(item => item.id === payment.userId);
    if (!user) throw new Error("Пользователь заказа не найден.");
    const now = new Date();
    const currentEnd = user.subscriptionUntil ? new Date(user.subscriptionUntil) : now;
    const start = new Date((currentEnd > now ? currentEnd : now).getTime());
    start.setUTCDate(start.getUTCDate() + PLAN.days);
    user.subscriptionUntil = start.toISOString();
    user.projectLimit = payment.projectCount;
    user.status = "active";
    user.updatedAt = now.toISOString();
    payment.status = "paid";
    payment.providerPaymentId = String(providerPaymentId || "");
    payment.paidAt = now.toISOString();
    await write(state);
    return payment;
  }

  async function adminSnapshot() {
    const state = await read();
    const paidPayments = state.payments.filter(payment => payment.status === "paid" && payment.paidAt);
    const monthKey = value => String(value).slice(0, 7);
    const now = new Date();
    const months = Array.from({ length: 6 }, (_, index) => {
      const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (5 - index), 1));
      return { month: date.toISOString().slice(0, 7), label: date.toLocaleDateString("ru-RU", { month: "short", year: "2-digit", timeZone: "UTC" }) };
    });
    const revenueSeries = months.map(item => {
      const matching = paidPayments.filter(payment => monthKey(payment.paidAt) === item.month);
      return { ...item, amount: matching.reduce((sum, payment) => sum + payment.amount, 0), payments: matching.length };
    });
    const currentMonth = revenueSeries.at(-1)?.amount || 0;
    const previousMonth = revenueSeries.at(-2)?.amount || 0;
    return {
      plan: PLAN,
      users: state.users.map(user => ({ ...publicUser(user), projects: state.projects.filter(project => project.userId === user.id).length })),
      payments: state.payments.map(payment => ({ ...payment, email: state.users.find(user => user.id === payment.userId)?.email || "" })),
      revenue: {
        total: paidPayments.reduce((sum, payment) => sum + payment.amount, 0),
        currentMonth,
        previousMonth,
        growthPercent: previousMonth ? Math.round(((currentMonth - previousMonth) / previousMonth) * 1000) / 10 : null,
        series: revenueSeries
      }
    };
  }

  async function updateUser(userId, { status, subscriptionUntil, projectLimit }) {
    const state = await read();
    const user = state.users.find(item => item.id === userId);
    if (!user) throw new Error("Пользователь не найден.");
    if (status && ["active", "pending_payment", "blocked"].includes(status)) user.status = status;
    if (subscriptionUntil !== undefined) user.subscriptionUntil = subscriptionUntil ? new Date(subscriptionUntil).toISOString() : null;
    if (projectLimit !== undefined) {
      const limit = Number(projectLimit);
      if (!Number.isInteger(limit) || limit < PLAN.minProjects || limit > PLAN.maxProjects) throw new Error(`Лимит должен быть от ${PLAN.minProjects} до ${PLAN.maxProjects}.`);
      user.projectLimit = limit;
    }
    user.updatedAt = new Date().toISOString();
    await write(state);
    return publicUser(user);
  }

  return { register, authenticate, getUser, listProjects, createProject, deleteProject, ownsProject, createPayment, completePayment, adminSnapshot, updateUser };
}

function isSubscriptionActive(user) {
  return user?.status === "active" && Boolean(user.subscriptionUntil) && new Date(user.subscriptionUntil) > new Date();
}

module.exports = { PLAN, createSaasStore, hashPassword, verifyPassword, isSubscriptionActive, normalizeEmail };
