const path = require("path");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PLACEHOLDER_RE = /(replace|example|changeme|your[-_ ]|test|demo)/i;

function enabled(value) {
  return String(value || "").toLowerCase() === "true";
}

function present(value, minLength = 1) {
  const text = String(value || "").trim();
  return text.length >= minLength && !PLACEHOLDER_RE.test(text);
}

function inspectLaunchReadiness(env = process.env) {
  const blockers = [];
  const warnings = [];
  const add = (condition, message, target = blockers) => { if (!condition) target.push(message); };
  const mode = String(env.APP_MODE || "internal").toLowerCase();
  const publicUrl = String(env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  const dataDir = String(env.DATA_DIR || "");
  const backupDir = String(env.BACKUP_DIR || "");
  const billingMode = String(env.BILLING_MODE || "manual").toLowerCase();
  const sessionSecret = String(env.SAAS_SESSION_SECRET || "");
  const dataSecret = String(env.SAAS_DATA_SECRET || "");

  add(mode === "external", "APP_MODE должен быть external.");
  add(/^https:\/\//i.test(publicUrl) && !PLACEHOLDER_RE.test(publicUrl), "PUBLIC_BASE_URL должен содержать боевой HTTPS-домен.");
  add(path.isAbsolute(dataDir), "DATA_DIR должен быть абсолютным каталогом постоянного диска.");
  add(present(sessionSecret, 32), "SAAS_SESSION_SECRET должен быть случайным значением длиной не менее 32 символов.");
  add(present(dataSecret, 32), "SAAS_DATA_SECRET должен быть отдельным случайным значением длиной не менее 32 символов.");
  add(!sessionSecret || !dataSecret || sessionSecret !== dataSecret, "SAAS_SESSION_SECRET и SAAS_DATA_SECRET не должны совпадать.");
  add(EMAIL_RE.test(String(env.EXTERNAL_ADMIN_EMAIL || "")), "Укажите корректный EXTERNAL_ADMIN_EMAIL.");
  add(present(env.EXTERNAL_ADMIN_PASSWORD, 12), "EXTERNAL_ADMIN_PASSWORD должен содержать не менее 12 символов и не быть шаблонным.");

  add(enabled(env.LEGAL_PROFILE_CONFIRMED), "Подтвердите проверенные реквизиты: LEGAL_PROFILE_CONFIRMED=true.");
  add(String(env.LEGAL_NAME || "").trim().split(/\s+/).length >= 4, "Укажите полное наименование ИП в LEGAL_NAME.");
  add(/^\d{12}$/.test(String(env.LEGAL_INN || "")), "LEGAL_INN должен содержать 12 цифр.");
  add(/^\d{15}$/.test(String(env.LEGAL_OGRNIP || "")), "LEGAL_OGRNIP должен содержать 15 цифр.");
  add(present(env.LEGAL_ADDRESS, 12), "Укажите полный адрес для юридически значимых обращений в LEGAL_ADDRESS.");
  add(EMAIL_RE.test(String(env.LEGAL_EMAIL || "")), "Укажите рабочий LEGAL_EMAIL.");
  add(present(env.LEGAL_PHONE, 7), "Укажите контактный LEGAL_PHONE.");

  add(["manual", "platega"].includes(billingMode), "BILLING_MODE должен быть manual или platega.");
  if (billingMode === "platega") {
    add(present(env.PLATEGA_MERCHANT_ID, 8), "Укажите PLATEGA_MERCHANT_ID.");
    add(present(env.PLATEGA_API_KEY, 16), "Укажите PLATEGA_API_KEY.");
    add(/^https:\/\//i.test(String(env.PLATEGA_API_BASE || "https://app.platega.io")), "PLATEGA_API_BASE должен использовать HTTPS.");
    add(Number(env.PLATEGA_PAYMENT_METHOD || 2) > 0, "Укажите PLATEGA_PAYMENT_METHOD.");
    add(enabled(env.ONLINE_RECEIPTS_READY), "Подтвердите рабочую схему кассы и чеков: ONLINE_RECEIPTS_READY=true.");
  } else {
    warnings.push("BILLING_MODE=manual: клиент увидит обращение за счётом вместо онлайн-оплаты.");
  }

  const smtpReady = present(env.SMTP_HOST) && Number(env.SMTP_PORT || 0) > 0 && present(env.SMTP_USER) && present(env.SMTP_PASS, 8) && present(env.EMAIL_FROM);
  add(smtpReady, "Настройте SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS и EMAIL_FROM для восстановления пароля и поддержки.");
  add(enabled(env.TRUST_PROXY), "За reverse proxy установите TRUST_PROXY=true, иначе rate limiting будет видеть адрес proxy.");
  add(path.isAbsolute(backupDir), "BACKUP_DIR должен быть абсолютным каталогом резервных копий.");
  if (path.isAbsolute(dataDir) && path.isAbsolute(backupDir)) {
    const source = path.resolve(dataDir);
    const destination = path.resolve(backupDir);
    add(destination !== source && !destination.startsWith(`${source}${path.sep}`), "BACKUP_DIR должен находиться вне DATA_DIR.");
  }
  add(Number(env.BACKUP_RETENTION_DAYS || 0) >= 7, "BACKUP_RETENTION_DAYS должен быть не меньше 7 дней.");
  if (!present(env.TELEGRAM_BOT_TOKEN, 20)) warnings.push("Telegram-уведомления о сбоях фидов не настроены.");
  if (String(env.NODE_ENV || "").toLowerCase() !== "production") warnings.push("Для боевого запуска рекомендуется NODE_ENV=production.");

  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
    callbackUrl: publicUrl ? `${publicUrl}/api/billing/platega/callback` : "",
    healthUrl: publicUrl ? `${publicUrl}/api/health` : ""
  };
}

module.exports = { inspectLaunchReadiness };
