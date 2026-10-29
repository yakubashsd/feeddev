const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSaasStore, verifyPassword, hasWorkspaceAccess } = require("./saas-store");
const { createPlatega } = require("./platega");
const { runBackup } = require("./backup");

test("external accounts are isolated, billed per project and limited by purchased quantity", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feeddev-saas-"));
  try {
    const store = createSaasStore({ dataDir: dir, secret: "test-secret", blobEnabled: () => false });
    const user = await store.register({ email: "User@example.ru", password: "long-password", name: "Иван", acceptedOffer: true, acceptedPersonalData: true });
    assert.equal(user.email, "user@example.ru");
    const accepted = (await store.adminSnapshot()).audit.find(item => item.action === "register");
    assert.deepEqual(accepted.details, { offerVersion: "2026-09-22", privacyVersion: "2026-09-22", consentVersion: "2026-09-22" });
    assert.ok(await store.authenticate("USER@example.ru", "long-password"));
    assert.equal(await store.authenticate("user@example.ru", "wrong-password"), null);
    const trialProject = await store.createProject(user.id, "Пробный");
    assert.ok(trialProject.id);

    const payment = await store.createPayment(user.id, 10);
    assert.equal(payment.amount, 50000);
    await assert.rejects(store.completePaymentByProviderTransactionId(payment.id, 49999), /Сумма/);
    await store.completePaymentByProviderTransactionId(payment.id, 50000);
    const firstUntil = (await store.getUser(user.id)).subscriptionUntil;
    await store.completePaymentByProviderTransactionId(payment.id, 50000);
    assert.equal((await store.getUser(user.id)).subscriptionUntil, firstUntil, "repeated callback must be idempotent");

    const project = trialProject;
    assert.equal(await store.ownsProject(user.id, project.id), true);
    for (let index = 2; index <= 10; index += 1) await store.createProject(user.id, `Проект ${index}`);
    await assert.rejects(store.createProject(user.id, "Проект 11"), /доступно проектов: 10/);
    const snapshot = await store.adminSnapshot();
    assert.equal(snapshot.revenue.total, 50000);
    assert.equal(snapshot.revenue.currentMonth, 50000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("demo account has unlimited projects and feeds without changing limits for other clients", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "listingflow-demo-unlimited-"));
  try {
    const store = createSaasStore({ dataDir: dir, secret: "test-secret", blobEnabled: () => false });
    const demo = await store.register({ email: "DEMO@listingflow.ru", password: "demo-password", name: "Демо", acceptedOffer: true, acceptedPersonalData: true });
    assert.equal(demo.projectLimit, -1);
    assert.equal(demo.feedLimit, -1);
    assert.equal(demo.demoAccess, true);
    assert.equal(hasWorkspaceAccess({ email: "demo@listingflow.ru", status: "active" }), true);

    const payment = await store.createPayment(demo.id, 1);
    await store.completePaymentByProviderTransactionId(payment.id, payment.amount);
    for (let index = 1; index <= 12; index += 1) await store.createProject(demo.id, `Демо-проект ${index}`);
    assert.equal((await store.listProjects(demo.id)).length, 12);

    const client = await store.register({ email: "client-limits@example.ru", password: "client-password", name: "Клиент", acceptedOffer: true, acceptedPersonalData: true });
    assert.equal(client.projectLimit, 1);
    assert.equal(client.feedLimit, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("feed history is persisted per client and can be filtered by project and feed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "listingflow-feed-history-"));
  try {
    const store = createSaasStore({ dataDir: dir, secret: "test-secret", blobEnabled: () => false });
    const first = await store.register({ email: "history-one@example.ru", password: "history-password", name: "Первый", acceptedOffer: true, acceptedPersonalData: true });
    const second = await store.register({ email: "history-two@example.ru", password: "history-password", name: "Второй", acceptedOffer: true, acceptedPersonalData: true });
    const project = await store.createProject(first.id, "История проекта");
    await store.recordFeedHistory(first.id, "feed-a", "create", { projectId: project.id, feedName: "Основной фид", objectCount: 12, xml: "не должен попасть в запись" });
    await store.recordFeedHistory(first.id, "feed-a", "edit", { projectId: project.id, feedName: "Основной фид", revision: 2 });
    await store.recordFeedHistory(first.id, "feed-b", "sync_error", { projectId: project.id, feedName: "Второй фид", error: "Источник недоступен" });
    await store.recordFeedHistory(second.id, "feed-a", "create", { projectId: project.id, feedName: "Чужой фид" });

    const history = await store.listFeedHistory(first.id, { projectId: project.id });
    assert.equal(history.length, 3);
    assert.equal(history[0].action, "sync_error");
    assert.equal(history[0].userId, undefined);
    assert.equal(history[1].details.revision, 2);
    assert.equal(history[2].details.xml, undefined);
    assert.equal((await store.listFeedHistory(first.id, { projectId: project.id, feedId: "feed-a", limit: 1 })).length, 1);
    assert.equal((await store.listFeedHistory(second.id, { projectId: project.id })).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Platega checkout uses merchant headers and verifies callback headers", async () => {
  const calls = [];
  const platega = createPlatega({
    merchantId: "merchant-1",
    secret: "secret-1",
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ redirect: "https://pay.platega.io/checkout/1", transactionId: "tr-1", status: "PENDING" }) };
    }
  });
  const result = await platega.checkoutUrl({ paymentId: "pay-1", orderId: "FD-1", amount: 5000, email: "u@example.ru", projectCount: 1, returnUrl: "https://app.example.ru/" });
  assert.equal(result.url, "https://pay.platega.io/checkout/1");
  assert.equal(calls[0].url, "https://app.platega.io/transaction/process");
  assert.equal(calls[0].options.headers["X-MerchantId"], "merchant-1");
  assert.equal(calls[0].options.headers["X-Secret"], "secret-1");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.paymentDetails.amount, 5000);
  assert.equal(body.id, undefined);
  assert.equal(JSON.parse(body.payload).orderId, "FD-1");
  assert.equal(platega.verifyNotification({ "x-merchantid": "merchant-1", "x-secret": "secret-1" }), true);
  assert.equal(platega.verifyNotification({ "x-merchantid": "merchant-1", "x-secret": "bad" }), false);
});

test("registration records distinct offer acceptance and personal-data consent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "listingflow-consent-"));
  try {
    const store = createSaasStore({ dataDir: dir, secret: "test-secret", blobEnabled: () => false });
    await assert.rejects(store.register({ email: "missing@example.ru", password: "long-password", name: "Клиент", acceptedOffer: true }), /отдельное согласие/);
    await assert.rejects(store.register({ email: "missing@example.ru", password: "long-password", name: "Клиент", acceptedPersonalData: true }), /принять публичную оферту/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("password verifier rejects malformed hashes", () => {
  assert.equal(verifyPassword("password", "broken"), false);
});

test("password reset tokens are one-use and expire safely", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "listingflow-reset-"));
  try {
    const store = createSaasStore({ dataDir: dir, secret: "test-secret", blobEnabled: () => false });
    await store.register({ email: "reset@example.ru", password: "old-password", name: "Клиент", acceptedOffer: true, acceptedPersonalData: true });
    assert.equal(await store.requestPasswordReset("missing@example.ru"), null);
    const reset = await store.requestPasswordReset("reset@example.ru");
    assert.ok(reset.token.length > 30);
    await store.resetPassword(reset.token, "new-password");
    assert.ok(await store.authenticate("reset@example.ru", "new-password"));
    assert.equal(await store.authenticate("reset@example.ru", "old-password"), null);
    await assert.rejects(store.resetPassword(reset.token, "another-password"), /недействительна/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("payment processing keeps an operator-visible event log", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "listingflow-payment-log-"));
  try {
    const store = createSaasStore({ dataDir: dir, secret: "test-secret", blobEnabled: () => false });
    const user = await store.register({ email: "payer@example.ru", password: "payer-password", name: "Плательщик", acceptedOffer: true, acceptedPersonalData: true });
    const payment = await store.createPayment(user.id, 2);
    await store.logPaymentEvent("callback_received", { orderId: payment.orderId, amount: payment.amount, source: "platega", status: "received" });
    await store.attachPaymentProviderTransaction(payment.orderId, "platega-tr-1");
    await store.completePaymentByProviderTransactionId("platega-tr-1", payment.amount);
    const events = (await store.adminSnapshot()).paymentLogs;
    assert.ok(events.some(item => item.event === "checkout_created"));
    assert.ok(events.some(item => item.event === "callback_received"));
    assert.ok(events.some(item => item.event === "payment_confirmed"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("backup creates an atomic snapshot with a manifest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "listingflow-backup-"));
  try {
    const dataDir = path.join(root, "data");
    const backupDir = path.join(root, "backups");
    fs.mkdirSync(dataDir);
    fs.writeFileSync(path.join(dataDir, "saas-store.enc"), "encrypted\n");
    const result = runBackup({ dataDir, backupDir, retentionDays: 30, now: new Date("2026-09-17T10:00:00.000Z") });
    assert.equal(fs.readFileSync(path.join(result, "data", "saas-store.enc"), "utf8"), "encrypted\n");
    assert.equal(JSON.parse(fs.readFileSync(path.join(result, "manifest.json"), "utf8")).service, "ListingFlow");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("owner can add a manager and archived projects stop consuming the paid limit", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feeddev-roles-"));
  try {
    const store = createSaasStore({ dataDir: dir, secret: "test-secret", blobEnabled: () => false });
    const manager = await store.createStaff({ email: "manager@example.ru", password: "manager-password", name: "Мария" });
    assert.equal(manager.role, "manager");
    assert.equal((await store.authenticateStaff("MANAGER@example.ru", "manager-password")).id, manager.id);

    const user = await store.register({ email: "client@example.ru", password: "client-password", name: "Клиент", acceptedOffer: true, acceptedPersonalData: true });
    const payment = await store.createPayment(user.id, 1);
    await store.completePaymentByProviderTransactionId(payment.id, payment.amount);
    const first = await store.createProject(user.id, "Первый проект");
    await assert.rejects(store.createProject(user.id, "Второй проект"), /доступно проектов: 1/);
    await store.updateProject(first.id, { status: "archived" }, manager.id);
    const second = await store.createProject(user.id, "Второй проект");
    assert.equal(second.status, "active");

    const snapshot = await store.adminSnapshot();
    assert.equal(snapshot.staff.length, 1);
    assert.equal(snapshot.users[0].activeProjects, 1);
    assert.ok(snapshot.audit.some(item => item.entityType === "project" && item.action === "update"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
