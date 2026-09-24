const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createSaasStore } = require("./saas-store");

test("commercial user journeys work end-to-end and tenants stay isolated", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "listingflow-commercial-e2e-"));
  const dataSecret = "commercial-e2e-data-secret-abcdefghijklmnopqrstuvwxyz";
  Object.assign(process.env, {
    APP_MODE: "external", DATA_DIR: dataDir, SAAS_DATA_SECRET: dataSecret,
    SAAS_SESSION_SECRET: "commercial-e2e-session-secret-abcdefghijklmnopqrstuvwxyz",
    PUBLIC_BASE_URL: "", BLOB_READ_WRITE_TOKEN: "", VERCEL: "", TELEGRAM_BOT_TOKEN: "",
    BILLING_MODE: "platega", ONLINE_RECEIPTS_READY: "true",
    PLATEGA_MERCHANT_ID: "merchant-commercial-e2e", PLATEGA_API_KEY: "platega-commercial-e2e-secret",
    EXTERNAL_ADMIN_EMAIL: "owner@listingflow.test", EXTERNAL_ADMIN_PASSWORD: "owner-commercial-password",
    LEGAL_PROFILE_CONFIRMED: "true", LEGAL_NAME: "ИП Якубаш Сергей Дмитриевич",
    LEGAL_INN: "720326517332", LEGAL_OGRNIP: "326723200087150",
    LEGAL_ADDRESS: "Тюменская область, город Тюмень", LEGAL_EMAIL: "owner@listingflow.test",
    SMTP_HOST: "", SMTP_USER: "", SMTP_PASS: "", EMAIL_FROM: ""
  });
  const store = createSaasStore({ dataDir, secret: dataSecret, blobEnabled: () => false });
  const server = http.createServer(require("./server"));
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(route, { method = "GET", cookie = "", body, headers = {} } = {}) {
    const response = await fetch(base + route, {
      method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("json") ? await response.json() : await response.text();
    return { response, data };
  }
  const cookieFrom = result => result.response.headers.get("set-cookie").split(";")[0];
  const registration = (email, name, extra = {}) => request("/api/auth-register", {
    method: "POST", body: { email, name, password: "client-commercial-password", acceptedOffer: true, acceptedPersonalData: true, ...extra }
  });

  const anonymous = await request("/api/auth-session");
  assert.equal(anonymous.response.status, 200);
  assert.equal(anonymous.data.authenticated, false);

  const missingConsent = await request("/api/auth-register", {
    method: "POST", body: { email: "no-consent@example.ru", name: "Без согласия", password: "client-commercial-password", acceptedOffer: true }
  });
  assert.equal(missingConsent.response.status, 400);
  assert.match(missingConsent.data.error, /согласие/);

  const registeredA = await registration("client-a@example.ru", "Клиент А");
  assert.equal(registeredA.response.status, 201);
  const cookieA = cookieFrom(registeredA);
  const duplicate = await registration("CLIENT-A@example.ru", "Дубликат");
  assert.equal(duplicate.response.status, 409);

  const wrongLogin = await request("/api/auth-login", { method: "POST", body: { email: "client-a@example.ru", password: "wrong-password" } });
  assert.equal(wrongLogin.response.status, 401);

  const unpaidProject = await request("/api/projects", { method: "POST", cookie: cookieA, body: { name: "Без оплаты" } });
  assert.equal(unpaidProject.response.status, 402);

  const userA = (await store.adminSnapshot()).users.find(user => user.email === "client-a@example.ru");
  const payment = await store.createPayment(userA.id, 1);
  await store.attachPaymentProviderTransaction(payment.orderId, "provider-commercial-1");
  const rejectedCallback = await request("/api/billing/platega/callback", {
    method: "POST", headers: { "X-MerchantId": "wrong", "X-Secret": "wrong" },
    body: { id: "provider-commercial-1", amount: 5000, currency: "RUB", status: "CONFIRMED" }
  });
  assert.equal(rejectedCallback.response.status, 403);
  const callback = () => request("/api/billing/platega/callback", {
    method: "POST", headers: { "X-MerchantId": "merchant-commercial-e2e", "X-Secret": "platega-commercial-e2e-secret" },
    body: { id: "provider-commercial-1", amount: 5000, currency: "RUB", status: "CONFIRMED" }
  });
  assert.equal((await callback()).response.status, 200);
  const firstUntil = (await store.getUser(userA.id)).subscriptionUntil;
  assert.equal((await callback()).response.status, 200);
  assert.equal((await store.getUser(userA.id)).subscriptionUntil, firstUntil, "duplicate callback must not extend twice");

  const activeSession = await request("/api/auth-session", { cookie: cookieA });
  assert.equal(activeSession.data.subscriptionActive, true);
  assert.equal(activeSession.data.user.projectLimit, 1);

  const projectAResult = await request("/api/projects", { method: "POST", cookie: cookieA, body: { name: "Проект клиента А" } });
  assert.equal(projectAResult.response.status, 201);
  const projectA = projectAResult.data;
  const overLimit = await request("/api/projects", { method: "POST", cookie: cookieA, body: { name: "Лишний проект" } });
  assert.equal(overLimit.response.status, 409);

  const initialState = await request(`/api/projects/${projectA.id}/state`, { method: "PUT", cookie: cookieA, body: { state: { editor: { objects: 1 } } } });
  assert.equal(initialState.response.status, 200);
  assert.equal(initialState.response.headers.get("etag"), '"1"');
  const staleState = await request(`/api/projects/${projectA.id}/state`, {
    method: "PUT", cookie: cookieA, headers: { "If-Match": '"0"' }, body: { state: { editor: { objects: 2 } } }
  });
  assert.equal(staleState.response.status, 409);
  assert.equal(staleState.data.current.revision, 1);

  const validXml = "<feed><object><ExternalId>1</ExternalId><Description>Квартира с отделкой</Description><Address>Тюмень, улица Тестовая, 1</Address><BargainTerms><Price>5000000</Price></BargainTerms></object></feed>";
  const invalidPublication = await request("/api/feeds", {
    method: "POST", cookie: cookieA,
    body: { projectId: projectA.id, platform: "cian", name: "Невалидный", objectCount: 1, xml: "<feed></feed>" }
  });
  assert.equal(invalidPublication.response.status, 422);
  const published = await request("/api/feeds", {
    method: "POST", cookie: cookieA,
    body: { projectId: projectA.id, sourceId: "source-a", platform: "cian", sourceType: "file", name: "Боевой фид", objectCount: 1, xml: validXml }
  });
  assert.equal(published.response.status, 201);
  const publicBefore = await request(`/f/${published.data.slug}.xml`);
  assert.equal(publicBefore.response.status, 200);
  assert.match(publicBefore.data, /5000000/);

  const invalidUpdate = await request(`/api/feeds/${published.data.slug}`, {
    method: "PUT", cookie: cookieA,
    body: { projectId: projectA.id, sourceId: "source-a", platform: "cian", sourceType: "file", name: "Боевой фид", objectCount: 1, xml: "<feed><object></object></feed>" }
  });
  assert.equal(invalidUpdate.response.status, 422);
  const publicAfterInvalid = await request(`/f/${published.data.slug}.xml`);
  assert.match(publicAfterInvalid.data, /5000000/, "invalid update must not replace last successful release");

  const updated = await request(`/api/feeds/${published.data.slug}`, {
    method: "PUT", cookie: cookieA,
    body: { projectId: projectA.id, sourceId: "source-a", platform: "cian", sourceType: "file", name: "Боевой фид", objectCount: 1, xml: validXml.replace("5000000", "5100000") }
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.data.releases.length, 2);
  const releases = await request(`/api/feeds/${published.data.slug}/releases`, { cookie: cookieA });
  assert.equal(releases.data.releases.length, 2);

  const registeredB = await registration("client-b@example.ru", "Клиент Б");
  assert.equal(registeredB.response.status, 201);
  const cookieB = cookieFrom(registeredB);
  const userB = (await store.adminSnapshot()).users.find(user => user.email === "client-b@example.ru");
  const paymentB = await store.createPayment(userB.id, 1);
  await store.completePaymentByProviderTransactionId(paymentB.id, paymentB.amount);
  const forbiddenState = await request(`/api/projects/${projectA.id}/state`, { cookie: cookieB });
  assert.equal(forbiddenState.response.status, 403);
  const feedsB = await request("/api/feeds", { cookie: cookieB });
  assert.deepEqual(feedsB.data.feeds, []);
  const hiddenRelease = await request(`/api/feeds/${published.data.slug}/releases`, { cookie: cookieB });
  assert.equal(hiddenRelease.response.status, 404);

  const support = await request("/api/support/tickets", {
    method: "POST", cookie: cookieA,
    body: { category: "publication", title: "Не вижу обновление", description: "Проверяю реальный путь обращения по опубликованному фиду.", projectId: projectA.id }
  });
  assert.equal(support.response.status, 201);
  assert.equal((await request("/api/support/tickets", { cookie: cookieA })).data.tickets.length, 1);
  assert.equal((await request("/api/support/tickets", { cookie: cookieB })).data.tickets.length, 0);

  const exported = await request("/api/account/export", { cookie: cookieA });
  assert.equal(exported.response.status, 200);
  assert.equal(exported.data.account.email, "client-a@example.ru");
  assert.equal(exported.data.projects.length, 1);
  assert.equal(exported.data.feeds.length, 1);
  assert.ok(exported.data.projects.every(project => project.name !== "Клиент Б"));
  const deletion = await request("/api/account/deletion-request", { method: "POST", cookie: cookieA });
  assert.equal(deletion.response.status, 202);
  assert.match(deletion.data.ticket.title, /Удаление аккаунта/);

  const ownerLogin = await request("/api/auth-login", {
    method: "POST", body: { email: "owner@listingflow.test", password: "owner-commercial-password" }
  });
  assert.equal(ownerLogin.response.status, 200);
  const ownerCookie = cookieFrom(ownerLogin);
  const admin = await request("/api/admin", { cookie: ownerCookie });
  assert.equal(admin.response.status, 200);
  assert.equal(admin.data.users.length, 2);
  assert.ok(admin.data.paymentLogs.some(item => item.event === "payment_confirmed"));
  const adminTickets = await request("/api/admin/support-tickets", { cookie: ownerCookie });
  assert.equal(adminTickets.response.status, 200);
  assert.equal(adminTickets.data.tickets.length, 2);

  const archived = await request(`/api/projects/${projectA.id}`, { method: "DELETE", cookie: cookieA });
  assert.equal(archived.response.status, 200);
  assert.equal((await request(`/f/${published.data.slug}.xml`)).response.status, 200, "archiving must preserve public URL");
  const replacement = await request("/api/projects", { method: "POST", cookie: cookieA, body: { name: "Новый активный проект" } });
  assert.equal(replacement.response.status, 201);
  const restoreBlocked = await request(`/api/projects/${projectA.id}/restore`, { method: "POST", cookie: cookieA });
  assert.equal(restoreBlocked.response.status, 409);

  await store.updateUser(userA.id, { subscriptionUntil: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() }, "test");
  const grace = await request("/api/auth-session", { cookie: cookieA });
  assert.equal(grace.data.subscriptionActive, false);
  assert.equal(grace.data.subscriptionReadOnly, true);
  assert.equal((await request("/api/projects", { cookie: cookieA })).response.status, 200);
  const writeDuringGrace = await request(`/api/projects/${replacement.data.id}/state`, { method: "PUT", cookie: cookieA, body: { state: {} } });
  assert.equal(writeDuringGrace.response.status, 402);
  assert.equal((await request("/api/account/export", { cookie: cookieA })).response.status, 200);

  await store.updateUser(userA.id, { subscriptionUntil: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() }, "test");
  const afterGrace = await request(`/api/projects/${replacement.data.id}/state`, { cookie: cookieA });
  assert.equal(afterGrace.response.status, 402);

  const logout = await request("/api/auth-logout", { method: "POST", cookie: cookieA });
  assert.equal(logout.response.status, 200);
  const oldSession = await request("/api/projects", { cookie: cookieA });
  assert.equal(oldSession.response.status, 401);
});
