const crypto = require("crypto");

function md5(value) {
  return crypto.createHash("md5").update(String(value)).digest("hex");
}

function createFreeKassa(config = {}) {
  const merchantId = String(config.merchantId || "");
  const secret1 = String(config.secret1 || "");
  const secret2 = String(config.secret2 || "");
  const paymentUrl = String(config.paymentUrl || "https://pay.freekassa.ru/");

  function configured() {
    return Boolean(merchantId && secret1 && secret2);
  }

  function checkoutUrl({ orderId, amount, email, userId }) {
    if (!configured()) throw new Error("FreeKassa не настроена.");
    const formattedAmount = Number(amount).toFixed(2);
    const params = new URLSearchParams({
      m: merchantId,
      oa: formattedAmount,
      o: orderId,
      currency: "RUB",
      s: md5(`${merchantId}:${formattedAmount}:${secret1}:RUB:${orderId}`),
      em: String(email || ""),
      us_user_id: String(userId || "")
    });
    return `${paymentUrl}?${params}`;
  }

  function verifyNotification(payload = {}) {
    const notifiedMerchant = String(payload.MERCHANT_ID || payload.merchant_id || "");
    const amount = String(payload.AMOUNT || payload.amount || "");
    const orderId = String(payload.MERCHANT_ORDER_ID || payload.order_id || "");
    const signature = String(payload.SIGN || payload.sign || "").toLowerCase();
    const expected = md5(`${merchantId}:${amount}:${secret2}:${orderId}`);
    const left = Buffer.from(signature);
    const right = Buffer.from(expected);
    return notifiedMerchant === merchantId && left.length === right.length && crypto.timingSafeEqual(left, right);
  }

  return { configured, checkoutUrl, verifyNotification };
}

module.exports = { createFreeKassa };
