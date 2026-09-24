const test = require("node:test");
const assert = require("node:assert/strict");
const { inspectLaunchReadiness } = require("./launch-readiness");

function productionEnv(overrides = {}) {
  return {
    APP_MODE: "external", NODE_ENV: "production", PUBLIC_BASE_URL: "https://listingflow.ru",
    DATA_DIR: "/var/lib/listingflow", BACKUP_DIR: "/var/backups/listingflow", BACKUP_RETENTION_DAYS: "30",
    SAAS_SESSION_SECRET: "s".repeat(40), SAAS_DATA_SECRET: "d".repeat(40),
    EXTERNAL_ADMIN_EMAIL: "owner@listingflow.ru", EXTERNAL_ADMIN_PASSWORD: "A-strong-owner-password",
    LEGAL_PROFILE_CONFIRMED: "true", LEGAL_NAME: "ИП Якубаш Сергей Дмитриевич", LEGAL_INN: "720326517332",
    LEGAL_OGRNIP: "326723200087150", LEGAL_ADDRESS: "Российская Федерация, Тюменская область, город Тюмень",
    LEGAL_EMAIL: "yakubashsd@gmail.com", LEGAL_PHONE: "+7 900 000-00-00", BILLING_MODE: "platega",
    PLATEGA_MERCHANT_ID: "merchant-123", PLATEGA_API_KEY: "p".repeat(32), PLATEGA_API_BASE: "https://app.platega.io",
    PLATEGA_PAYMENT_METHOD: "2", ONLINE_RECEIPTS_READY: "true", SMTP_HOST: "smtp.mail.ru", SMTP_PORT: "587",
    SMTP_USER: "mail@listingflow.ru", SMTP_PASS: "smtp-password", EMAIL_FROM: "ListingFlow <mail@listingflow.ru>",
    TRUST_PROXY: "true", TELEGRAM_BOT_TOKEN: "123456789:abcdefghijklmnopqrstuvwxyz", ...overrides
  };
}

test("production configuration passes launch readiness", () => {
  const result = inspectLaunchReadiness(productionEnv());
  assert.equal(result.ready, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.callbackUrl, "https://listingflow.ru/api/billing/platega/callback");
});

test("online payments stay blocked without confirmed receipts", () => {
  const result = inspectLaunchReadiness(productionEnv({ ONLINE_RECEIPTS_READY: "false" }));
  assert.equal(result.ready, false);
  assert.match(result.blockers.join("\n"), /кассы и чеков/);
});

test("secrets must be distinct and backups must be outside data", () => {
  const result = inspectLaunchReadiness(productionEnv({ SAAS_DATA_SECRET: "s".repeat(40), BACKUP_DIR: "/var/lib/listingflow/backups" }));
  assert.equal(result.ready, false);
  assert.match(result.blockers.join("\n"), /не должны совпадать/);
  assert.match(result.blockers.join("\n"), /вне DATA_DIR/);
});
