const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createSaasStore } = require("./saas-store");

test("a client who paid for one project cannot create a second active project through the API", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "listingflow-project-limit-"));
  const dataSecret = "integration-data-secret-for-project-limit";
  Object.assign(process.env, {
    APP_MODE: "external", DATA_DIR: dataDir, SAAS_DATA_SECRET: dataSecret,
    SAAS_SESSION_SECRET: "integration-session-secret-for-project-limit",
    PUBLIC_BASE_URL: "http://127.0.0.1", BLOB_READ_WRITE_TOKEN: "", VERCEL: "",
    LEGAL_PROFILE_CONFIRMED: "true", LEGAL_NAME: "ИП Якубаш Сергей Дмитриевич",
    LEGAL_INN: "720326517332", LEGAL_OGRNIP: "326723200087150",
    LEGAL_ADDRESS: "Тюменская область, город Тюмень", LEGAL_EMAIL: "owner@example.ru"
  });
  const store = createSaasStore({ dataDir, secret: dataSecret, blobEnabled: () => false });
  const user = await store.register({
    email: "one-project@example.ru", password: "one-project-password", name: "Один проект",
    acceptedOffer: true, acceptedPersonalData: true
  });
  const payment = await store.createPayment(user.id, 1);
  await store.completePaymentByProviderTransactionId(payment.id, payment.amount);

  const server = http.createServer(require("./server"));
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/auth-login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "one-project@example.ru", password: "one-project-password" })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const create = name => fetch(`${base}/api/projects`, {
    method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name })
  });

  const first = await create("Первый проект");
  assert.equal(first.status, 201);
  const second = await create("Второй проект");
  assert.equal(second.status, 409);
  assert.match((await second.json()).error, /доступно проектов: 1/);

  const list = await fetch(`${base}/api/projects`, { headers: { Cookie: cookie } });
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.equal(body.limit, 1);
  assert.equal(body.projects.filter(project => project.status !== "archived").length, 1);
});
