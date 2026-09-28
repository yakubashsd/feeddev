const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PLAN = Object.freeze({ code: "projects", name: "Проекты", unitAmount: 5000, days: 30, minProjects: 1, maxProjects: 10 });
// -1 is reserved for manually granted, non-billable unlimited access.
// Paid plans remain limited by PLAN.maxProjects.
const UNLIMITED_PROJECT_LIMIT = -1;
const FILE_NAME = "saas-store.enc";
const BLOB_PATH = "private/saas-store.enc";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function emptyState() { return { version: 3, users: [], staff: [], projects: [], payments: [], passwordResets: [], paymentLogs: [], audit: [] }; }
function migrateState(value) {
  const state = value && typeof value === "object" ? value : emptyState();
  state.version = 3;
  for (const key of ["users", "staff", "projects", "payments", "passwordResets", "paymentLogs", "audit"]) state[key] = Array.isArray(state[key]) ? state[key] : [];
  for (const project of state.projects) {
    project.status ||= "active";
    project.updatedAt ||= project.createdAt || new Date().toISOString();
  }
  for (const account of [...state.users, ...state.staff]) account.sessionVersion = Number(account.sessionVersion || 1);
  return state;
}
function normalizeEmail(value) { return String(value || "").trim().toLowerCase(); }
function deriveKey(secret) { return crypto.createHash("sha256").update(String(secret)).digest(); }
function encrypt(value, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}
function decrypt(value, secret) {
  const bytes = Buffer.from(String(value).trim(), "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(secret), bytes.subarray(0, 12));
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
function publicUser(user = {}) {
  return { id: user.id, role: "client", email: user.email, name: user.name, company: user.company || "", phone: user.phone || "", status: user.status, projectLimit: Number(user.projectLimit || 1), subscriptionUntil: user.subscriptionUntil || null, sessionVersion: Number(user.sessionVersion || 1), createdAt: user.createdAt, updatedAt: user.updatedAt || user.createdAt };
}
function publicStaff(staff) { return { id: staff.id, email: staff.email, name: staff.name, role: staff.role, status: staff.status, sessionVersion: Number(staff.sessionVersion || 1), createdAt: staff.createdAt }; }
function isUnlimitedProjectLimit(value) { return Number(value) === UNLIMITED_PROJECT_LIMIT; }
function projectLimitForEnforcement(value) {
  return isUnlimitedProjectLimit(value) ? Infinity : Math.min(PLAN.maxProjects, Math.max(PLAN.minProjects, Number(value || 1)));
}

function createSaasStore({ dataDir, secret, blobEnabled = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN) }) {
  if (!secret) throw new Error("Для внешнего режима задайте SAAS_DATA_SECRET.");
  const filePath = path.join(dataDir, FILE_NAME);
  let writeQueue = Promise.resolve();
  const blobApi = () => require("@vercel/blob");

  async function read() {
    try {
      if (!blobEnabled()) {
        if (!fs.existsSync(filePath)) return emptyState();
        return migrateState(decrypt(fs.readFileSync(filePath, "utf8"), secret));
      }
      const result = await blobApi().get(BLOB_PATH, { access: "private", useCache: false });
      return result?.stream ? migrateState(decrypt(await new Response(result.stream).text(), secret)) : emptyState();
    } catch (error) {
      if (error.code === "ENOENT" || error.status === 404) return emptyState();
      throw error;
    }
  }
  async function write(state) {
    const encoded = encrypt(state, secret);
    if (!blobEnabled()) {
      fs.mkdirSync(dataDir, { recursive: true });
      const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      fs.writeFileSync(tempPath, `${encoded}\n`, { mode: 0o600 });
      fs.renameSync(tempPath, filePath);
      return;
    }
    await blobApi().put(BLOB_PATH, encoded, { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "text/plain; charset=utf-8" });
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
    if (String(password).length < 8) throw new Error("Пароль должен содержать не менее 8 символов.");
    if (!name) throw new Error("Укажите имя.");
    if (acceptedOffer !== true) throw new Error("Для регистрации необходимо принять публичную оферту.");
    if (acceptedPersonalData !== true) throw new Error("Отметьте отдельное согласие на обработку персональных данных.");
    return mutate(async state => {
      if (state.users.some(user => user.email === email) || state.staff.some(user => user.email === email)) throw new Error("Аккаунт с таким email уже существует.");
      const now = new Date().toISOString();
      const user = { id: crypto.randomUUID(), email, name: name.slice(0, 120), company: String(company).trim().slice(0, 160), phone: String(phone).trim().slice(0, 40), passwordHash: hashPassword(password), status: "pending_payment", projectLimit: 1, subscriptionUntil: null, offerAcceptedAt: now, personalDataConsentAt: now, offerVersion: String(offerVersion).slice(0, 40), privacyVersion: String(privacyVersion).slice(0, 40), consentVersion: String(consentVersion).slice(0, 40), createdAt: now, updatedAt: now };
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
    if (String(password).length < 8) throw new Error("Пароль должен содержать не менее 8 символов.");
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
      if (!isSubscriptionActive(user)) throw new Error("Сначала оплатите тариф.");
      const limit = projectLimitForEnforcement(user.projectLimit);
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
  async function restoreProject(userId, projectId) { return mutate(async state => { const project = state.projects.find(item => item.id === projectId && item.userId === userId); if (!project) return false; const user = state.users.find(item => item.id === userId); const limit = projectLimitForEnforcement(user?.projectLimit); if (state.projects.filter(item => item.userId === userId && item.status !== "archived").length >= limit) throw new Error(`На тарифе доступно проектов: ${limit}. Освободите место или увеличьте лимит.`); project.status = "active"; project.archivedAt = null; project.updatedAt = new Date().toISOString(); audit(state, userId, "restore", "project", projectId, { name: project.name }); return true; }); }
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
    return { plan: PLAN, users, projects: state.projects.map(project => ({ ...project, client: publicUser(state.users.find(user => user.id === project.userId) || {}) })), payments: state.payments.map(payment => ({ ...payment, email: state.users.find(user => user.id === payment.userId)?.email || "", clientName: state.users.find(user => user.id === payment.userId)?.name || "" })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))), paymentLogs: state.paymentLogs.slice(0, 500), staff: state.staff.map(publicStaff), audit: state.audit.slice(0, 100).map(item => ({ ...item, actor: actorNames.get(item.actor) || item.actor })), revenue: { total: paidPayments.reduce((sum, payment) => sum + payment.amount, 0), currentMonth, previousMonth, growthPercent: previousMonth ? Math.round(((currentMonth - previousMonth) / previousMonth) * 1000) / 10 : null, mrr: users.filter(user => isSubscriptionActive(user)).reduce((sum, user) => sum + (isUnlimitedProjectLimit(user.projectLimit) ? 0 : user.projectLimit * PLAN.unitAmount), 0), series } };
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
    email = normalizeEmail(email); if (!EMAIL_RE.test(email)) throw new Error("Укажите корректный email."); if (String(password).length < 8) throw new Error("Пароль должен содержать не менее 8 символов."); if (!String(name || "").trim()) throw new Error("Укажите имя.");
    return mutate(async state => { if (state.users.some(user => user.email === email) || state.staff.some(user => user.email === email)) throw new Error("Аккаунт с таким email уже существует."); const staff = { id: crypto.randomUUID(), email, name: String(name).trim().slice(0, 120), role: role === "owner" ? "owner" : "manager", status: "active", passwordHash: hashPassword(password), createdAt: new Date().toISOString() }; state.staff.push(staff); audit(state, actor, "create", "staff", staff.id, { role: staff.role }); return publicStaff(staff); });
  }
  async function deleteStaff(staffId, actor = "owner") { return mutate(async state => { const before = state.staff.length; state.staff = state.staff.filter(item => item.id !== staffId); if (state.staff.length === before) return false; audit(state, actor, "delete", "staff", staffId); return true; }); }

  async function listPayments(userId) { const state = await read(); return state.payments.filter(payment => payment.userId === userId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(({ userId: _, ...payment }) => payment); }
  async function recordAudit(actor, action, entityType, entityId, details = {}) { return mutate(async state => { audit(state, actor, action, entityType, entityId, details); return true; }); }

  return { register, authenticate, authenticateStaff, requestPasswordReset, resetPassword, getUser, getStaff, revokeSessions, listProjects, createProject, deleteProject, renameProject, ownsProject, hasProject, restoreProject, createPayment, listPayments, completePayment, completePaymentByProviderTransactionId, attachPaymentProviderTransaction, setPaymentProviderStatus, logPaymentEvent, recordAudit, adminSnapshot, updateUser, updateProject, createStaff, deleteStaff };
}
function isSubscriptionActive(user) { return user?.status === "active" && Boolean(user.subscriptionUntil) && new Date(user.subscriptionUntil) > new Date(); }
const SUBSCRIPTION_GRACE_DAYS = 7;
function subscriptionGraceUntil(user) {
  if (!user?.subscriptionUntil) return null;
  const until = new Date(user.subscriptionUntil);
  if (!Number.isFinite(until.getTime())) return null;
  until.setUTCDate(until.getUTCDate() + SUBSCRIPTION_GRACE_DAYS);
  return until.toISOString();
}
function hasSubscriptionReadAccess(user) { return isSubscriptionActive(user) || (user?.status === "active" && Boolean(subscriptionGraceUntil(user)) && new Date(subscriptionGraceUntil(user)) > new Date()); }
module.exports = { PLAN, createSaasStore, hashPassword, verifyPassword, isSubscriptionActive, hasSubscriptionReadAccess, subscriptionGraceUntil, normalizeEmail };
