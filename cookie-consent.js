(() => {
  const key = "listingflow-analytics-consent-v1";
  const version = "2026-09-22";
  const notice = document.querySelector("#cookieNotice");
  const dialog = document.querySelector("#cookiePrefs");
  const analytics = document.querySelector("#analyticsConsent");
  const webvisor = document.querySelector("#webvisorConsent");
  if (!notice || !dialog || !analytics || !webvisor) return;

  function maskWebvisorFields(root = document) {
    root.querySelectorAll?.("input, textarea, [contenteditable=true]").forEach(field => field.classList.add("ym-disable-keys"));
  }
  maskWebvisorFields();
  new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(node => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.matches?.("input, textarea, [contenteditable=true]")) node.classList.add("ym-disable-keys");
      maskWebvisorFields(node);
    }
  }))).observe(document.documentElement, { childList: true, subtree: true });

  function read() {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "null");
      return value?.version === version ? value : null;
    } catch { return null; }
  }

  function load(value) {
    if (!value?.analytics || window.ym) return;
    window.disableYaCounter112732392 = false;
    window.ym = window.ym || function () { (window.ym.a = window.ym.a || []).push(arguments); };
    window.ym.l = window.ym.l || Date.now();
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://mc.yandex.ru/metrika/tag.js?id=112732392";
    window.ym(112732392, "init", {
      ssr: true, webvisor: value.webvisor === true, clickmap: true, ecommerce: "dataLayer",
      referrer: document.referrer, url: location.href, accurateTrackBounce: true, trackLinks: true
    });
    document.head.appendChild(script);
  }

  function save(value) {
    const previous = read();
    localStorage.setItem(key, JSON.stringify({ ...value, version, savedAt: new Date().toISOString() }));
    notice.hidden = true;
    if (dialog.open) dialog.close();
    if (previous?.analytics && !value.analytics && window.ym) {
      window.ym(112732392, "destruct");
      document.cookie.split(";").map(part => part.trim().split("=")[0]).filter(name => /^_ym/.test(name)).forEach(name => {
        document.cookie = `${name}=; Max-Age=0; path=/; SameSite=Lax`;
      });
      location.reload();
      return;
    }
    load(value);
  }

  function openPrefs(event) {
    event?.preventDefault();
    const current = read() || { analytics: false, webvisor: false };
    analytics.checked = current.analytics;
    webvisor.checked = current.webvisor;
    dialog.showModal();
  }

  const current = read();
  if (!current) notice.hidden = false;
  else load(current);
  document.querySelector("#acceptAnalytics").addEventListener("click", () => save({ analytics: true, webvisor: true }));
  document.querySelector("#declineAnalytics").addEventListener("click", () => save({ analytics: false, webvisor: false }));
  document.querySelector("#openCookiePrefs").addEventListener("click", openPrefs);
  document.querySelector("#manageCookies").addEventListener("click", openPrefs);
  document.querySelector("#cancelCookiePrefs").addEventListener("click", () => dialog.close());
  document.querySelector("#saveCookiePrefs").addEventListener("click", () => save({ analytics: analytics.checked, webvisor: analytics.checked && webvisor.checked }));
})();
