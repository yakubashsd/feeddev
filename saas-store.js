const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PLAN = Object.freeze({ code: "projects", name: "Проекты", unitAmount: 5000, days: 30, minProjects: 1, maxProjects: 10 });
// -1 is reserved for manually granted, non-billable unlimited access.
// Paid plans remain limited by PLAN.maxProjects.
const UNLIMITED_PROJECT_LIMIT = -1;
const UNLIMITED_FEED_LIMIT = -1;
const DEFAULT_FEED_LIMIT = 80;
const TRIAL_DAYS = 14;
const TRIAL_PROJECT_LIMIT = 1;
const TRIAL_FEED_LIMIT = 1;
const DEMO_UNLIMITED_EMAIL = "demo@listingflow.ru";
const FILE_NAME = "saas-store.enc";
const BLOB_PATH = "private/saas-store.enc";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 128;

function emptyState() { return { version: 3, users: [], staff: [], projects: [], payments: [], passwordResets: [], paymentLogs: [], audit: [], feedHistory: [] }; }
function migrateState(value) {
  const state = value && typeof value === "object" ? value : emptyState();
  state.version = 3;
  for (const key of ["users", "staff", "projects", "payments", "passwordResets", "paymentLogs", "audit", "feedHistory"]) state[key] = Array.isArray(state[key]) ? state[key] : [];
  for (const project of state.projects) {
    project.status ||= "active";
    project.updatedAt ||= project.createdAt || new Date().toISOString();
  }
  for (const account of [...state.users, ...state.staff]) account.sessionVersion = Number(account.sessionVersion || 1);
  return state;
}
function normalizeEmail(value) { return String(value || "").trim().toLowerCase(); }
function deriveKey(secret) { return crypto.createHash("sha256").update(String(secret)).digest(); }
function encrypt(value, secretOrKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.isBuffer(secretOrKey) ? secretOrKey : deriveKey(secretOrKey), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}
function decrypt(value, secretOrKey) {
  const bytes = Buffer.from(String(value).trim(), "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.isBuffer(secretOrKey) ? secretOrKey : deriveKey(secretOrKey), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
}
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) { return `${salt}:${crypto.scryptSync(String(password), salt, 64).toString("hex")}`; }
function verifyPassword(password, stored) {
  const [salt, expectedHex] = String(stored || "").split(":");
  if (!salt || !expectedHex) return false;
  const actual = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function isDemoUnlimitedUser(user = {}) { return normalizeEmail(user.email) === DEMO_UNLIMITED_EMAIL; }
function publicUser(user = {}) {
  const unlimited = isDemoUnlimitedUser(user);
  const trial = isTrialActive(user);
  return { id: user.id, role: "client", email: user.email, name: user.name, company: user.company || "", phone: user.phone || "", status: user.status, demoAccess: unlimited, projectLimit: unlimited ? UNLIMITED_PROJECT_LIMIT : trial ? TRIAL_PROJECT_LIMIT : Number(user.projectLimit || 1), feedLimit: unlimited ? UNLIMITED_FEED_LIMIT : trial ? TRIAL_FEED_LIMIT : DEFAULT_FEED_LIMIT, subscriptionUntil: user.subscriptionUntil || null, trialUntil: user.trialUntil || null, trialActive: trial, sessionVersion: Number(user.sessionVersion || 1), createdAt: user.createdAt, updatedAt: user.updatedAt || user.createdAt };
}
function publicStaff(staff) { return { id: staff.id, email: staff.email, name: staff.name, role: staff.role, status: staff.status, sessionVersion: Number(staff.sessionVersion || 1), createdAt: staff.createdAt }; }
function isUnlimitedProjectLimit(value) { return Number(value) === UNLIMITED_PROJECT_LIMIT; }
function projectLimitForEnforcement(value) {
  return isUnlimitedProjectLimit(value) ? Infinity : Math.min(PLAN.maxProjects, Math.max(PLAN.minProjects, Number(value || 1)));
}
function projectLimitForUser(user) {
  return isDemoUnlimitedUser(user) ? Infinity : projectLimitForEnforcement(user?.projectLimit);
}

function createSaasStore({ dataDir, secret, blobEnabled = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN) }) {
  if (!secret) throw new Error("Для внешнего режима задайте SAAS_DATA_SECRET.");
  const filePath = path.join(dataDir, FILE_NAME);
  const encryptionKey = deriveKey(secret);
  let writeQueue = Promise.resolve();
  let localCache = null;
  let localCacheStamp = "";
  let blobCache = null;
  let blobCacheExpiresAt = 0;

  function fileStamp() {
    try {
      const stat = fs.statSync(filePath);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "missing";
    }
  }

  const blobApi = () => require("@vercel/blob");

  async function read() {
    try {
      if (!blobEnabled()) {
        const stamp = fileStamp();
        if (stamp === "missing") {
          localCache = null;
          localCacheStamp = stamp;
          return emptyState();
        }
        if (localCache && localCacheStamp === stamp) return localCache;
        localCache = migrateState(decrypt(fs.readFileSync(filePath, "utf8"), encryptionKey));
        localCacheStamp = stamp;
        return localCache;
      }
      if (blobCache && blobCacheExpiresAt > Date.now()) return blobCache;
      const result = await blobApi().get(BLOB_PATH, { access: "private", useCache: false });
      blobCache = result?.stream ? migrateState(decrypt(await new Response(result.stream).text(), encryptionKey)) : emptyState();
      blobCacheExpiresAt = Date.now() + 2000;
      return blobCache;
    } catch (error) {
      if (error.code === "ENOENT" || error.status === 404) return emptyState();
      throw error;
    }
  }
  async function write(state) {
    const encoded = encrypt(state, encryptionKey);
    if (!blobEnabled()) {
      fs.mkdirSync(dataDir, { recursive: true });
      const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      fs.writeFileSync(tempPath, `${encoded}\n`, { mode: 0o600 });
      fs.renameSync(tempPath, filePath);
      localCache = state;
      localCacheStamp = fileStamp();
      return;
    }
    await blobApi().put(BLOB_PATH, encoded, { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "text/plain; charset=utf-8" });
    blobCache = state;
    blobCacheExpiresAt = Date.now() + 2000;
  }
  function mutate(callback) {
    const operation = writeQueue.then(async () => {
      const state = await read();
      const result = await callback(state);
      await write(state);
      return result;
    });
    writeQueue = operation.catch(() => {});
    return operation;
  }
  function audit(state, actor, action, entityType, entityId, details = {}) {
    state.audit.unshift({ id: crypto.randomUUID(), actor: String(actor || "system"), action, entityType, entityId, details, createdAt: new Date().toISOString() });
    state.audit = state.audit.slice(0, 1000);
  }
  function paymentLog(state, event, details = {}) {
    state.paymentLogs.unshift({ id: crypto.randomUUID(), event: String(event), orderId: String(details.orderId || ""), providerPaymentId: String(details.providerPaymentId || ""), amount: Number(details.amount || 0), status: String(details.status || ""), source: String(details.source || "server"), message: String(details.message || "").slice(0, 500), createdAt: new Date().toISOString() });
    state.paymentLogs = state.paymentLogs.slice(0, 2000);
  }

  async function register({ email, password, name, company = "", phone = "", acceptedOffer = false, acceptedPersonalData = false, offerVersion = "2026-09-22", privacyVersion = "2026-09-22", consentVersion = "2026-09-22" }) {
    email = normalizeEmail(email); name = String(name || "").trim();
    if (!EMAIL_RE.test(email)) throw new Error("Укажите корректный email.");
    if (String(password).length < MIN_PASSWORD_LENGTH || String(password).length > MAX_PASSWORD_LENGTH) throw new Error(`Пароль должен содержать от ${MIN_PASSWORD_LENGTH} до ${MAX_PASSWORD_LENGTH} символов.`);
    if (!name) throw new Error("Укажите имя.");
    if (acceptedOffer !== true) throw new Error("Для регистрации необходимо принять публичную оферту.");
    if (acceptedPersonalData !== true) throw new Error("Отметьте отдельное согласие на обработку персональных данных.");
    return mutate(async state => {
      if (state.users.some(user => user.email === email) || state.staff.some(user => user.email === email)) throw new Error("Аккаунт с таким email уже существует.");
      const now = new Date().toISOString();
      const trialUntil = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const user = { id: crypto.randomUUID(), email, name: name.slice(0, 120), company: String(company).trim().slice(0, 160), phone: String(phone).trim().slice(0, 40), passwordHash: hashPassword(password), status: "trial", projectLimit: TRIAL_PROJECT_LIMIT, feedLimit: TRIAL_FEED_LIMIT, subscriptionUntil: null, trialUntil, offerAcceptedAt: now, personalDataConsentAt: now, offerVersion: String(offerVersion).slice(0, 40), privacyVersion: String(privacyVersion).slice(0, 40), consentVersion: String(consentVersion).slice(0, 40), createdAt: now, updatedAt: now };
      state.users.push(user); audit(state, user.id, "register", "client", user.id, { offerVersion: user.offerVersion, privacyVersion: user.privacyVersion, consentVersion: user.consentVersion }); return publicUser(user);
    });
  }
  async function authenticate(email, password) {
    const state = await read(); const user = state.users.find(item => item.email === normalizeEmail(email));
    return !user || user.status === "blocked" || !verifyPassword(password, user.passwordHash) ? null : publicUser(user);
  }
  async function authenticateStaff(email, password) {
    const state = await read(); const staff = state.staff.find(item => item.email === normalizeEmail(email));
    return !staff || staff.status !== "active" || !verifyPassword(password, staff.passwordHash) ? null : publicStaff(staff);
  }
  async function requestPasswordReset(email, ttlMinutes = 30) {
    email = normalizeEmail(email);
    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const result = await mutate(async state => {
      const user = state.users.find(item => item.email === email && item.status !== "blocked");
      state.passwordResets = state.passwordResets.filter(item => new Date(item.expiresAt) > new Date() && (!user || item.userId !== user.id));
      if (!user) return null;
      const expiresAt = new Date(Date.now() + Math.max(5, Math.min(60, Number(ttlMinutes) || 30)) * 60 * 1000).toISOString();
      state.passwordResets.push({ id: crypto.randomUUID(), userId: user.id, tokenHash, expiresAt, createdAt: new Date().toISOString() });
      audit(state, user.id, "request", "password-reset", user.id);
      return { token, user: publicUser(user), expiresAt };
    });
    return result;
  }
  async function resetPassword(token, password) {
    if (String(password).length < MIN_PASSWORD_LENGTH || String(password).length > MAX_PASSWORD_LENGTH) throw new Error(`Пароль должен содержать от ${MIN_PASSWORD_LENGTH} до ${MAX_PASSWORD_LENGTH} символов.`);
    const tokenHash = crypto.createHash("sha256").update(String(token || "")).digest("hex");
    return mutate(async state => {
      const reset = state.passwordResets.find(item => item.tokenHash === tokenHash && new Date(item.expiresAt) > new Date());
      if (!reset) throw new Error("Ссылка недействительна или срок её действия истёк.");
      const user = state.users.find(item => item.id === reset.userId);
      if (!user) throw new Error("Аккаунт не найден.");
      user.passwordHash = hashPassword(password);
      user.sessionVersion = Number(user.sessionVersion || 1) + 1;
      user.updatedAt = new Date().toISOString();
      state.passwordResets = state.passwordResets.filter(item => item.userId !== user.id);
      audit(state, user.id, "complete", "password-reset", user.id);
      return publicUser(user);
    });
  }
  async function getUser(userId) { const state = await read(); const user = state.users.find(item => item.id === userId); return user ? publicUser(user) : null; }
  async function getStaff(staffId) { const state = await read(); const staff = state.staff.find(item => item.id === staffId); return staff ? publicStaff(staff) : null; }
  async function revokeSessions({ userId = "", staffId = "" } = {}) {
    return mutate(async state => {
      const account = userId ? state.users.find(item => item.id === userId) : state.staff.find(item => item.id === staffId);
      if (!account) return false;
      account.sessionVersion = Number(account.sessionVersion || 1) + 1;
      account.updatedAt = new Date().toISOString();
      audit(state, userId || staffId, "revoke_sessions", userId ? "client" : "staff", userId || staffId);
      return true;
    });
  }
  async function listProjects(userId) { const state = await read(); return state.projects.filter(project => project.userId === userId).map(({ userId: _, ...project }) => project); }
  async function createProject(userId, name) {
    name = String(name || "").trim(); if (!name) throw new Error("Укажите название проекта.");
    return mutate(async state => {
      const user = state.users.find(item => item.id === userId);
      if (!user || user.status === "blocked") throw new Error("Аккаунт недоступен.");
      if (!hasWorkspaceAccess(user)) throw new Error("Тестовый период закончился. Оплатите тариф, чтобы продолжить.");
      const limit = projectLimitForUser(user);
      if (state.projects.filter(project => project.userId === userId && project.status !== "archived").length >= limit) throw new Error(`На тарифе доступно проектов: ${limit} (учитываются только активные).`);
      const now = new Date().toISOString(); const project = { id: crypto.randomUUID(), userId, name: name.slice(0, 100), status: "active", createdAt: now, updatedAt: now };
      state.projects.push(project); audit(state, userId, "create", "project", project.id, { name: project.name }); const { userId: _, ...result } = project; return result;
    });
  }
async function deleteProject(userId, projectId) {
    return mutate(async state => { const project = state.projects.find(item => item.id === projectId && item.userId === userId); if (!project) return false; if (project.status !== "archived") { project.status = "archived"; project.archivedAt = new Date().toISOString(); project.updatedAt = project.archivedAt; audit(state, userId, "archive", "project", projectId, { name: project.name }); } return true; });
  }
  async function ownsProject(userId, projectId) { const state = await read(); return state.projects.some(project => project.userId === userId && project.id === projectId && project.status !== "archived"); }
  async function hasProject(userId, projectId) { const state = await read(); return state.projects.some(project => project.userId === userId && project.id === projectId); }
  async function restoreProject(userId, projectId) { return mutate(async state => { const project = state.projects.find(item => item.id === projectId && item.userId === userId); if (!project) return false; const user = state.users.find(item => item.id === userId); const limit = projectLimitForUser(user); if (state.projects.filter(item => item.userId === userId && item.status !== "archived").length >= limit) throw new Error(`На тарифе доступно проектов: ${limit}. Освободите место или увеличьте лимит.`); project.status = "active"; project.archivedAt = null; project.updatedAt = new Date().toISOString(); audit(state, userId, "restore", "project", projectId, { name: project.name }); return true; }); }
  async function createPayment(userId, projectCount = 1) {
    projectCount = Number(projectCount); if (!Number.isInteger(projectCount) || projectCount < PLAN.minProjects || projectCount > PLAN.maxProjects) throw new Error(`Выберите от ${PLAN.minProjects} до ${PLAN.maxProjects} проектов.`);
    return mutate(async state => {
      if (!state.users.some(user => user.id === userId && user.status !== "blocked")) throw new Error("Аккаунт не найден.");
      const payment = { id: crypto.randomUUID(), orderId: `FD-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`, userId, projectCount, amount: PLAN.unitAmount * projectCount, currency: "RUB", status: "pending", createdAt: new Date().toISOString(), paidAt: null };
      state.payments.push(payment); audit(state, userId, "create", "payment", payment.id, { amount: payment.amount, projectCount }); paymentLog(state, "checkout_created", { orderId: payment.orderId, amount: payment.amount, status: payment.status, source: "client" }); return payment;
    });
  }
  async function completePayment(orderId, providerPaymentId = "", notifiedAmount, source = "platega") {
    return mutate(async state => {
      const payment = state.payments.find(item => item.orderId === orderId); if (!payment) throw new Error("Заказ не найден.");
      if (Number(notifiedAmount) !== payment.amount) { paymentLog(state, "callback_rejected", { orderId, amount: notifiedAmount, status: "rejected", source, message: "Сумма платежа не совпадает с заказом." }); throw new Error("Сумма платежа не совпадает с заказом."); }
      if (payment.status === "paid") { paymentLog(state, "callback_duplicate", { orderId, providerPaymentId, amount: notifiedAmount, status: "paid", source }); return payment; }
      const user = state.users.find(item => item.id === payment.userId); if (!user) throw new Error("Пользователь заказа не найден.");
      const now = new Date(); const currentEnd = user.subscriptionUntil ? new Date(user.subscriptionUntil) : now; const end = new Date((currentEnd > now ? currentEnd : now).getTime()); end.setUTCDate(end.getUTCDate() + PLAN.days);
      Object.assign(user, { subscriptionUntil: end.toISOString(), projectLimit: payment.projectCount, status: "active", updatedAt: now.toISOString() });
      Object.assign(payment, { status: "paid", providerPaymentId: String(providerPaymentId || ""), paidAt: now.toISOString() }); audit(state, source, "paid", "payment", payment.id, { amount: payment.amount }); paymentLog(state, "payment_confirmed", { orderId, providerPaymentId, amount: payment.amount, status: "paid", source }); return payment;
    });
  }
  async function completePaymentByProviderTransactionId(transactionId, notifiedAmount) {
    return mutate(async state => {
      const payment = state.payments.find(item => item.id === transactionId || item.providerPaymentId === transactionId); if (!payment) throw new Error("Заказ не найден.");
      if (Number(notifiedAmount) !== payment.amount) { paymentLog(state, "callback_rejected", { orderId: payment.orderId, providerPaymentId: transactionId, amount: notifiedAmount, status: "rejected", source: "platega", message: "Сумма платежа не совпадает с заказом." }); throw new Error("Сумма платежа не совпадает с заказом."); }
      if (payment.status === "paid") { paymentLog(state, "callback_duplicate", { orderId: payment.orderId, providerPaymentId: transactionId, amount: notifiedAmount, status: "paid", source: "platega" }); return payment; }
      const user = state.users.find(item => item.id === payment.userId); if (!user) throw new Error("Пользователь заказа не найден.");
      const now = new Date(); const currentEnd = user.subscriptionUntil ? new Date(user.subscriptionUntil) : now; const end = new Date((currentEnd > now ? currentEnd : now).getTime()); end.setUTCDate(end.getUTCDate() + PLAN.days);
      Object.assign(user, { subscriptionUntil: end.toISOString(), projectLimit: payment.projectCount, status: "active", updatedAt: now.toISOString() });
      Object.assign(payment, { status: "paid", providerPaymentId: String(transactionId || ""), paidAt: now.toISOString() }); audit(state, "platega", "paid", "payment", payment.id, { amount: payment.amount }); paymentLog(state, "payment_confirmed", { orderId: payment.orderId, providerPaymentId: transactionId, amount: payment.amount, status: "paid", source: "platega" }); return payment;
    });
  }
  async function attachPaymentProviderTransaction(orderId, providerPaymentId) {
    return mutate(async state => {
      const payment = state.payments.find(item => item.orderId === orderId); if (!payment) throw new Error("Заказ не найден.");
      if (!providerPaymentId) return payment;
      payment.providerPaymentId = String(providerPaymentId);
      paymentLog(state, "checkout_provider_created", { orderId, providerPaymentId: payment.providerPaymentId, amount: payment.amount, status: payment.status, source: "platega" });
      return payment;
    });
  }
  async function setPaymentProviderStatus(providerPaymentId, providerStatus, message = "") {
    return mutate(async state => {
      const payment = state.payments.find(item => item.providerPaymentId === String(providerPaymentId) || item.orderId === String(providerPaymentId));
      if (!payment) throw new Error("Заказ не найден.");
      const normalized = String(providerStatus || "").toUpperCase();
      if (payment.status === "paid" && normalized !== "CHARGEBACKED") return payment;
      if (normalized === "CANCELED") payment.status = "failed";
      else if (normalized === "CHARGEBACKED") payment.status = "chargebacked";
      else return payment;
      payment.updatedAt = new Date().toISOString();
      paymentLog(state, "payment_status_changed", { orderId: payment.orderId, providerPaymentId, amount: payment.amount, status: payment.status, source: "platega", message });
      return payment;
    });
  }
  async function logPaymentEvent(event, details = {}) { return mutate(async state => { paymentLog(state, event, details); return true; }); }
  async function adminSnapshot() {
    const state = await read(); const paidPayments = state.payments.filter(payment => payment.status === "paid" && payment.paidAt); const now = new Date();
    const months = Array.from({ length: 6 }, (_, index) => { const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (5 - index), 1)); return { month: date.toISOString().slice(0, 7), label: date.toLocaleDateString("ru-RU", { month: "short", year: "2-digit", timeZone: "UTC" }) }; });
    const series = months.map(item => { const matching = paidPayments.filter(payment => String(payment.paidAt).startsWith(item.month)); return { ...item, amount: matching.reduce((sum, payment) => sum + payment.amount, 0), payments: matching.length }; });
    const users = state.users.map(user => { const projects = state.projects.filter(project => project.userId === user.id); const payments = state.payments.filter(payment => payment.userId === user.id).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))); return { ...publicUser(user), projects, activeProjects: projects.filter(project => project.status !== "archived").length, revenue: payments.filter(payment => payment.status === "paid").reduce((sum, payment) => sum + payment.amount, 0), payments }; });
    const currentMonth = series.at(-1)?.amount || 0, previousMonth = series.at(-2)?.amount || 0;
    const actorNames = new Map([...state.users, ...state.staff].map(account => [account.id, account.email]));
    return { plan: PLAN, users, projects: state.projects.map(project => ({ ...project, client: publicUser(state.users.find(user => user.id === project.userId) || {}) })), payments: state.payments.map(payment => ({ ...payment, email: state.users.find(user => user.id === payment.userId)?.email || "", clientName: state.users.find(user => user.id === payment.userId)?.name || "" })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))), paymentLogs: state.paymentLogs.slice(0, 500), staff: state.staff.map(publicStaff), audit: state.audit.slice(0, 100).map(item => ({ ...item, actor: actorNames.get(item.actor) || item.actor })), revenue: { total: paidPayments.reduce((sum, payment) => sum + payment.amount, 0), currentMonth, previousMonth, growthPercent: previousMonth ? Math.round(((currentMonth - previousMonth) / previousMonth) * 1000) / 10 : null, mrr: users.filter(user => isSubscriptionActive(user)).reduce((sum, user) => sum + (isDemoUnlimitedUser(user) || isUnlimitedProjectLimit(user.projectLimit) ? 0 : user.projectLimit * PLAN.unitAmount), 0), series } };
  }
  async function updateUser(userId, changes, actor = "owner") {
    return mutate(async state => { const user = state.users.find(item => item.id === userId); if (!user) throw new Error("Пользователь не найден."); if (changes.status && ["active", "pending_payment", "blocked"].includes(changes.status)) user.status = changes.status; if (changes.subscriptionUntil !== undefined) user.subscriptionUntil = changes.subscriptionUntil ? new Date(changes.subscriptionUntil).toISOString() : null; if (changes.projectLimit !== undefined) { const limit = Number(changes.projectLimit); if (!Number.isInteger(limit) || (limit !== UNLIMITED_PROJECT_LIMIT && (limit < PLAN.minProjects || limit > PLAN.maxProjects))) throw new Error(`Лимит должен быть от ${PLAN.minProjects} до ${PLAN.maxProjects} либо «Безлимит».`); user.projectLimit = limit; } for (const key of ["name", "company", "phone"]) if (changes[key] !== undefined) user[key] = String(changes[key]).trim().slice(0, 160); user.updatedAt = new Date().toISOString(); audit(state, actor, "update", "client", user.id, { status: user.status, projectLimit: user.projectLimit }); return publicUser(user); });
  }
  async function renameProject(userId, projectId, name) {
    name = String(name || "").trim();
    if (!name) throw new Error("Укажите название проекта.");
    return mutate(async state => {
      const project = state.projects.find(item => item.userId === userId && item.id === projectId);
      if (!project) return null;
      project.name = name.slice(0, 100);
      project.updatedAt = new Date().toISOString();
      audit(state, userId, "rename", "project", project.id, { name: project.name });
      const { userId: _, ...result } = project;
      return result;
    });
  }
  async function updateProject(projectId, changes, actor = "owner") {
    return mutate(async state => { const project = state.projects.find(item => item.id === projectId); if (!project) throw new Error("Проект не найден."); if (changes.status && ["active", "archived"].includes(changes.status)) project.status = changes.status; if (changes.name !== undefined && String(changes.name).trim()) project.name = String(changes.name).trim().slice(0, 100); project.updatedAt = new Date().toISOString(); audit(state, actor, "update", "project", project.id, { status: project.status }); return project; });
  }
  async function createStaff({ email, password, name, role = "manager" }, actor = "owner") {
    email = normalizeEmail(email); if (!EMAIL_RE.test(email)) throw new Error("Укажите корректный email."); if (String(password).length < MIN_PASSWORD_LENGTH || String(password).length > MAX_PASSWORD_LENGTH) throw new Error(`Пароль должен содержать от ${MIN_PASSWORD_LENGTH} до ${MAX_PASSWORD_LENGTH} символов.`); if (!String(name || "").trim()) throw new Error("Укажите имя.");
    return mutate(async state => { if (state.users.some(user => user.email === email) || state.staff.some(user => user.email === email)) throw new Error("Аккаунт с таким email уже существует."); const staff = { id: crypto.randomUUID(), email, name: String(name).trim().slice(0, 120), role: role === "owner" ? "owner" : "manager", status: "active", passwordHash: hashPassword(password), createdAt: new Date().toISOString() }; state.staff.push(staff); audit(state, actor, "create", "staff", staff.id, { role: staff.role }); return publicStaff(staff); });
  }
  async function deleteStaff(staffId, actor = "owner") { return mutate(async state => { const before = state.staff.length; state.staff = state.staff.filter(item => item.id !== staffId); if (state.staff.length === before) return false; audit(state, actor, "delete", "staff", staffId); return true; }); }

  async function listPayments(userId) { const state = await read(); return state.payments.filter(payment => payment.userId === userId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(({ userId: _, ...payment }) => payment); }
  function safeFeedHistoryDetails(details = {}) {
    const blocked = new Set(["xml", "sourceUrl", "url", "password", "token", "secret"]);
    return Object.fromEntries(Object.entries(details).slice(0, 20).flatMap(([key, value]) => {
      if (blocked.has(String(key))) return [];
      if (typeof value === "string") return [[String(key).slice(0, 60), value.slice(0, 500)]];
      if (typeof value === "number" && Number.isFinite(value)) return [[String(key).slice(0, 60), value]];
      if (typeof value === "boolean") return [[String(key).slice(0, 60), value]];
      return [];
    }));
  }
  async function recordFeedHistory(userId, feedId, action, details = {}) {
    return mutate(async state => {
      const safeUserId = String(userId || "");
      const safeFeedId = String(feedId || "").slice(0, 160);
      if (!safeUserId || !safeFeedId) return false;
      const entry = {
        id: crypto.randomUUID(), userId: safeUserId, feedId: safeFeedId,
        projectId: String(details.projectId || "").slice(0, 120),
        feedName: String(details.feedName || "").slice(0, 160),
        action: String(action || "update").slice(0, 60),
        details: safeFeedHistoryDetails(details),
        createdAt: new Date().toISOString()
      };
      state.feedHistory.unshift(entry);
      state.feedHistory = state.feedHistory.slice(0, 5000);
      return true;
    });
  }
  async function listFeedHistory(userId, { projectId = "", feedId = "", limit = 200 } = {}) {
    const state = await read();
    const safeProjectId = String(projectId || "");
    const safeFeedId = String(feedId || "");
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 200));
    return state.feedHistory
      .filter(item => item.userId === String(userId || "") && (!safeProjectId || item.projectId === safeProjectId) && (!safeFeedId || item.feedId === safeFeedId))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, safeLimit)
      .map(({ userId: _, ...item }) => item);
  }
  async function recordAudit(actor, action, entityType, entityId, details = {}) { return mutate(async state => { audit(state, actor, action, entityType, entityId, details); return true; }); }

  return { register, authenticate, authenticateStaff, requestPasswordReset, resetPassword, getUser, getStaff, revokeSessions, listProjects, createProject, deleteProject, renameProject, ownsProject, hasProject, restoreProject, createPayment, listPayments, completePayment, completePaymentByProviderTransactionId, attachPaymentProviderTransaction, setPaymentProviderStatus, logPaymentEvent, recordAudit, recordFeedHistory, listFeedHistory, adminSnapshot, updateUser, updateProject, createStaff, deleteStaff };
}
function isSubscriptionActive(user) { return user?.status === "active" && Boolean(user.subscriptionUntil) && new Date(user.subscriptionUntil) > new Date(); }
function isTrialActive(user) { return user?.status === "trial" && Boolean(user.trialUntil) && new Date(user.trialUntil) > new Date(); }
function hasWorkspaceAccess(user) { return isDemoUnlimitedUser(user) || isSubscriptionActive(user) || isTrialActive(user); }
const SUBSCRIPTION_GRACE_DAYS = 7;
function subscriptionGraceUntil(user) {
  if (!user?.subscriptionUntil) return null;
  const until = new Date(user.subscriptionUntil);
  if (!Number.isFinite(until.getTime())) return null;
  until.setUTCDate(until.getUTCDate() + SUBSCRIPTION_GRACE_DAYS);
  return until.toISOString();
}
function hasSubscriptionReadAccess(user) { return hasWorkspaceAccess(user) || (user?.status === "active" && Boolean(subscriptionGraceUntil(user)) && new Date(subscriptionGraceUntil(user)) > new Date()); }
module.exports = { PLAN, DEFAULT_FEED_LIMIT, UNLIMITED_FEED_LIMIT, TRIAL_DAYS, TRIAL_PROJECT_LIMIT, TRIAL_FEED_LIMIT, createSaasStore, hashPassword, verifyPassword, isSubscriptionActive, isTrialActive, hasWorkspaceAccess, hasSubscriptionReadAccess, subscriptionGraceUntil, normalizeEmail, isDemoUnlimitedUser };
