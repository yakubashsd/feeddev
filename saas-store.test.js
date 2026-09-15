const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSaasStore, verifyPassword } = require("./saas-store");
const { createFreeKassa } = require("./freekassa");

test("external accounts are isolated, billed per project and limited by purchased quantity", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feeddev-saas-"));
  try {
    const store = createSaasStore({ dataDir: dir, secret: "test-secret", blobEnabled: () => false });
    const user = await store.register({ email: "User@example.ru", password: "long-password", name: "Иван" });
    assert.equal(user.email, "user@example.ru");
    assert.ok(await store.authenticate("USER@example.ru", "long-password"));
    assert.equal(await store.authenticate("user@example.ru", "wrong-password"), null);
    await assert.rejects(store.createProject(user.id, "Первый"), /оплатите/);

    const payment = await store.createPayment(user.id, 10);
    assert.equal(payment.amount, 75000);
    await assert.rejects(store.completePayment(payment.orderId, "fk-1", 74999), /Сумма/);
    await store.completePayment(payment.orderId, "fk-1", 75000);
    const firstUntil = (await store.getUser(user.id)).subscriptionUntil;
    await store.completePayment(payment.orderId, "fk-1", 75000);
    assert.equal((await store.getUser(user.id)).subscriptionUntil, firstUntil, "repeated callback must be idempotent");

    const project = await store.createProject(user.id, "Проект 1");
    assert.equal(await store.ownsProject(user.id, project.id), true);
    for (let index = 2; index <= 10; index += 1) await store.createProject(user.id, `Проект ${index}`);
    await assert.rejects(store.createProject(user.id, "Проект 11"), /доступно проектов: 10/);
    const snapshot = await store.adminSnapshot();
    assert.equal(snapshot.revenue.total, 75000);
    assert.equal(snapshot.revenue.currentMonth, 75000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("FreeKassa checkout and callback signatures use separate secrets", () => {
  const fk = createFreeKassa({ merchantId: "123", secret1: "first", secret2: "second" });
  const url = new URL(fk.checkoutUrl({ orderId: "FD-1", amount: 7500, email: "u@example.ru", userId: "u1" }));
  assert.equal(url.searchParams.get("oa"), "7500.00");
  assert.equal(url.searchParams.get("currency"), "RUB");
  const sign = crypto.createHash("md5").update("123:7500.00:second:FD-1").digest("hex");
  assert.equal(fk.verifyNotification({ MERCHANT_ID: "123", AMOUNT: "7500.00", MERCHANT_ORDER_ID: "FD-1", SIGN: sign }), true);
  assert.equal(fk.verifyNotification({ MERCHANT_ID: "123", AMOUNT: "1.00", MERCHANT_ORDER_ID: "FD-1", SIGN: sign }), false);
});

test("password verifier rejects malformed hashes", () => {
  assert.equal(verifyPassword("password", "broken"), false);
});
