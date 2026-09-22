function createPlatega(config = {}) {
  const merchantId = String(config.merchantId || "");
  const secret = String(config.secret || "");
  const apiBase = String(config.apiBase || "https://app.platega.io").replace(/\/+$/, "");
  const paymentMethod = Number(config.paymentMethod || 2);
  const fetchImpl = config.fetch || globalThis.fetch;

  function configured() {
    return Boolean(merchantId && secret);
  }

  function verifyNotification(headers = {}) {
    const header = name => String(headers[name] || headers[name.toLowerCase()] || "");
    return header("x-merchantid") === merchantId && header("x-secret") === secret;
  }

  async function checkoutUrl({ orderId, amount, email, projectCount, returnUrl, failedUrl }) {
    if (!configured()) throw new Error("Platega не настроена.");
    if (typeof fetchImpl !== "function") throw new Error("Fetch API недоступен для запроса Platega.");
    const body = {
      paymentMethod,
      paymentDetails: { amount: Number(amount), currency: "RUB" },
      description: `ListingFlow: ${projectCount || 1} проект(ов), заказ ${orderId}`,
      return: String(returnUrl || ""),
      failedUrl: String(failedUrl || returnUrl || ""),
      payload: JSON.stringify({ orderId, email, projectCount }),
      metadata: { userId: String(email || orderId || "listingflow") }
    };
    const response = await fetchImpl(`${apiBase}/transaction/process`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-MerchantId": merchantId,
        "X-Secret": secret
      },
      body: JSON.stringify(body)
    });
    const result = await response.json().catch(() => ({}));
    const redirect = result.redirect || result.url;
    if (!response.ok || !redirect) throw new Error(result.message || `Platega вернула HTTP ${response.status}`);
    return { url: redirect, transactionId: result.transactionId || result.id || "", status: result.status || "PENDING", raw: result };
  }

  return { configured, checkoutUrl, verifyNotification };
}

module.exports = { createPlatega };
