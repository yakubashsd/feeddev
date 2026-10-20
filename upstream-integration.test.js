"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const html = fs.readFileSync(path.join(__dirname, "feed-generator.html"), "utf8");
const layoutEditor = fs.readFileSync(path.join(__dirname, "layout-editor.js"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

function clientFunction(name) {
  const start = html.indexOf(`    function ${name}(`);
  assert.notEqual(start, -1, name);
  const rest = html.slice(start);
  const end = rest.slice(5).search(/\n    (?:async )?function /);
  return rest.slice(0, end + 5);
}

test("client scripts remain syntactically valid after integrating both branches", () => {
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
  new vm.Script(layoutEditor);
});

test("external clients always hydrate the server project state without a local-version prompt", () => {
  const hydrate = html.match(/    async function hydrateExternalProjectState\([\s\S]*?\n    }\n\n    async function renderBillingPayments/)[0];
  const push = html.match(/    async function pushExternalProjectState\([\s\S]*?\n    }\n\n    let projectStateSyncTimer/)[0];
  assert.doesNotMatch(hydrate, /confirm\(/);
  assert.doesNotMatch(hydrate, /pushExternalProjectState\(/);
  assert.match(hydrate, /for \(const key of projectStateKeys\(\)\) localStorage\.removeItem\(key\)/);
  assert.doesNotMatch(push, /const useLocal = confirm/);
  assert.doesNotMatch(push, /location\.reload\(\)/);
  assert.match(push, /обновите данные вручную/);
});

test("a direct project URL can hydrate on a fresh browser without a local project index", () => {
  assert.match(html, /let currentProject = projects\.find\(project => project\.id === requestedProject\) \|\| null/);
  assert.match(html, /const projectIdForStorage = \/\^\[a-f0-9-\]\{20,\}/);
  assert.match(html, /currentProject = next\.find\(project => project\.id === requestedProject\) \|\| null/);
});

test("open project sessions refresh in-memory state when a colleague saves a newer revision", () => {
  const boot = html.match(/    async function initializeAuth\([\s\S]*?\n    }\n\n    async function submitLogin/)[0];
  const workspace = html.match(/    function showWorkspace\([\s\S]*?\n    }\n\n    async function fetchWithTimeout/)[0];
  const poll = html.match(/    async function pollExternalProjectState\([\s\S]*?\n    }\n\n    async function renderBillingPayments/)[0];
  assert.match(boot, /let hydratedProjectState = shouldHydrateProject && await hydrateExternalProjectState\(\)/);
  assert.match(boot, /!shouldHydrateProject && runtimeMode === "external" && currentProject/);
  assert.match(boot, /hydratedProjectState[\s\S]*refreshProjectMemoryFromStorage\(\)/);
  assert.match(workspace, /pollExternalProjectState\(\)\.catch/);
  assert.match(poll, /remoteRevision <= cloudSaveRevision/);
  assert.match(poll, /refreshProjectMemoryFromStorage\(\)/);
  assert.match(poll, /renderAll\(\)/);
  assert.match(poll, /Проект изменён коллегой/);
});

test("project feeds are confirmed in cloud and refreshed when a background tab returns", () => {
  const persist = html.match(/    async function persistProjectStateNow\([\s\S]*?\n    }\n\n    \/\/ A background tab deliberately does not poll/)[0];
  assert.match(html, /document\.addEventListener\("visibilitychange"/);
  assert.match(html, /window\.addEventListener\("pageshow"/);
  assert.match(html, /window\.addEventListener\("online"/);
  assert.match(persist, /saveProjectSources\(\)/);
  assert.match(persist, /await pushExternalProjectState\(\)/);
  assert.match(persist, /cloudSavedSnapshot === JSON\.stringify\(captureProjectBrowserState\(\)\)/);
  assert.match(html, /Фид сохранён в проекте «\$\{currentProject\?\.name/);
  assert.match(html, /не подтверждён в облаке/);
});

test("project boot uses bounded requests and cannot wait forever on project APIs", () => {
  const sync = html.match(/    async function syncExternalProjects\([\s\S]*?\n    }\n\n    function projectStateKeys/)[0];
  const hydrate = html.match(/    async function hydrateExternalProjectState\([\s\S]*?\n    }\n\n    async function renderBillingPayments/)[0];
  assert.match(sync, /fetchWithTimeout\("\/api\/projects"/);
  assert.match(hydrate, /fetchWithTimeout\(`\/api\/projects\/\$\{encodeURIComponent\(currentProject\.id\)\}\/state`/);
});

test("project state polling uses conditional requests instead of downloading unchanged drafts", () => {
  const poll = html.match(/async function pollExternalProjectState\([\s\S]*?\n    }\n\n    async function renderBillingPayments/)[0];
  assert.match(poll, /If-None-Match/);
  assert.match(poll, /response\.status === 304/);
  assert.match(server, /req\.headers\["if-none-match"\] === etag/);
});

test("project bootstrap has a visible fallback and cannot reload forever", () => {
  const init = html.match(/    async function initializeAuth\([\s\S]*?\n    }\n\n    async function submitLogin/)[0];
  assert.match(html, /const bootWatchdog = window\.setTimeout/);
  assert.match(html, /Не удалось загрузить кабинет/);
  assert.match(html, /sessionStorage\.getItem\(key\)/);
  assert.match(init, /updateBootStatus\("Загружаю список проектов…"\)/);
  assert.doesNotMatch(init, /location\.reload\(\)/);
  assert.match(init, /Список проектов обновлён/);
  assert.match(init, /Данные проекта синхронизированы/);
  assert.match(init, /shouldHydrateProject && await hydrateExternalProjectState\(\)/);
  assert.match(html, /listingflow-bootstrap-hydrated/);
  assert.match(init, /!bootstrapStageDone\("projects"\) && await syncExternalProjects\(\)/);
  assert.match(init, /markBootstrapStage\("state"\)/);
  assert.doesNotMatch(init, /\n            location\.reload\(\);/);
});

test("account notification preferences are shared while project data stays scoped", () => {
  assert.match(html, /const monitorNotificationsStorageKey = "feed-generator-monitor-notifications-v1";/);
  assert.doesNotMatch(html, /const monitorNotificationsStorageKey = "feed-generator-monitor-notifications-v1" \+ projectSuffix/);
  assert.match(html, /const storageKey = "feed-generator-cian-v2" \+ projectSuffix/);
});

test("client history is a separate server-backed section", () => {
  assert.match(html, /data-nav="history"/);
  assert.match(html, /data-page="history"/);
  assert.match(html, /\/api\/feed-history/);
  assert.match(html, /Все изменения фидов сохраняются на сервере аккаунта/);
});

test("layout editor applies the size value and exposes a working canvas resize handle", () => {
  const draw = clientFunction("drawBrandedLayout");
  assert.match(draw, /placementInsideSafeZone\(baseImage, width, height, config\)/);
  assert.match(draw, /placement\.source\.sw/);
  assert.doesNotMatch(draw, /width \* \.78 \/ source\.sw/);
  assert.match(draw, /canvas\._brandLayoutPlacement = placement/);
  assert.match(layoutEditor, /drag\.resize/);
  assert.match(layoutEditor, /set\('brandSize'/);
  assert.doesNotMatch(html, /brandDragState/);
  assert.match(html, /\["\[", "\]"\]/);
});

test("branding editor exposes an editable safe placement zone and keeps guide pixels out of exports", () => {
  const rect = clientFunction("safeZoneRectForSize");
  const safeZone = clientFunction("drawSafeZoneGuide");
  const frame = clientFunction("drawBrandPreviewFrame");
  assert.match(rect, /safeZoneWidthPercent/);
  assert.match(rect, /safeZoneHeightPercent/);
  assert.match(safeZone, /safeZoneRect\(canvas, config\)/);
  assert.match(safeZone, /strokeRect\(rect\.x, rect\.y/);
  assert.match(frame, /drawSafeZoneGuide\(canvas, config\)/);
  assert.match(html, /class="brand-safe-zone-hint"/);
  assert.match(html, /id="brandSafeSize"/);
  assert.match(html, /id="brandSafeWidth"/);
  assert.match(html, /id="brandSafeHeight"/);
  assert.match(html, /id="brandSafeOffsetX"/);
  assert.match(html, /id="brandSafeOffsetY"/);
  assert.match(html, /brandedLayoutBlob\(canvas, activePlatform, projectConfig\)/);
  assert.match(layoutEditor, /data-layer="safe-zone"/);
  assert.match(layoutEditor, /drag\.safeZone/);
});

test("safe placement zone keeps legacy size profiles compatible", () => {
  const context = vm.createContext({ Math });
  vm.runInContext(clientFunction("safeZoneRectForSize"), context);
  const rect = context.safeZoneRectForSize(1200, 800, {
    safeZoneSizePercent: 70,
    safeZoneOffsetXPercent: 10,
    safeZoneOffsetYPercent: -10
  });
  assert.equal(rect.width, 840);
  assert.equal(rect.height, 560);
  assert.equal(rect.x, 300);
  assert.equal(rect.y, 40);
});

test("safe placement zone is rectangular and clamps the plan inside it on every platform", () => {
  const context = vm.createContext({ Math });
  vm.runInContext(clientFunction("safeZoneRectForSize"), context);
  vm.runInContext(clientFunction("placementInsideSafeZone"), context);
  context.visibleImageBounds = image => ({ sx: 0, sy: 0, sw: image.naturalWidth, sh: image.naturalHeight });
  const rect = context.safeZoneRectForSize(1200, 800, {
    safeZoneWidthPercent: 70,
    safeZoneHeightPercent: 50,
    safeZoneOffsetXPercent: 0,
    safeZoneOffsetYPercent: 0
  });
  assert.equal(rect.x, 180);
  assert.equal(rect.y, 200);
  assert.equal(rect.width, 840);
  assert.equal(rect.height, 400);
  const placement = context.placementInsideSafeZone({ naturalWidth: 1800, naturalHeight: 900 }, 1200, 800, {
    widthPercent: 100,
    offsetXPercent: 60,
    offsetYPercent: -60,
    safeZoneWidthPercent: 70,
    safeZoneHeightPercent: 50,
    safeZoneOffsetXPercent: 0,
    safeZoneOffsetYPercent: 0
  });
  assert.ok(placement.x >= rect.x);
  assert.ok(placement.y >= rect.y);
  assert.ok(placement.x + placement.width <= rect.x + rect.width);
  assert.ok(placement.y + placement.height <= rect.y + rect.height);
});

test("layout editor fits the background by default but keeps manual zoom usable", () => {
  assert.match(layoutEditor, /zoom=1, fitMode=true/);
  assert.match(layoutEditor, /canvas\.classList\.toggle\('le-fit-mode',fitMode\)/);
  assert.match(layoutEditor, /setZoom\(Math\.min\(1,availableWidth\/canvas\.width,availableHeight\/canvas\.height\), \{fit:true\}\)/);
  assert.match(layoutEditor, /if\(fitMode\)requestAnimationFrame\(fitCanvas\)/);
  assert.match(layoutEditor, /new ResizeObserver\(\(\)=>\{if\(fitMode\)fitCanvas\(\)\}\)\.observe\(stage\)/);
});

test("layout preview really scales a plan without a backdrop", () => {
  const calls = [];
  const context = vm.createContext({
    activePlatform: "cian",
    visibleImageBounds: image => ({ sx: 0, sy: 0, sw: image.naturalWidth, sh: image.naturalHeight }),
    drawCanvasLayers: () => {},
    templateText: value => value,
    canvasFontStack: value => value
  });
  vm.runInContext([clientFunction("safeZoneRectForSize"), clientFunction("placementInsideSafeZone"), clientFunction("drawBrandedLayout")].join("\n"), context);
  const canvas = {
    getContext: () => ({ clearRect: () => {}, save: () => {}, restore: () => {}, fillRect: () => {}, drawImage: (...args) => calls.push(args) }),
    width: 0,
    height: 0
  };
  const base = { naturalWidth: 100, naturalHeight: 200 };
  const config = { widthPercent: 38, offsetXPercent: 0, offsetYPercent: 0, canvasOpacity: 100, canvasColor: "#fff", headline: "", subline: "", canvasLayers: [] };
  context.drawBrandedLayout(base, null, canvas, config, {}, "cian");
  assert.equal(Math.round(canvas._brandLayoutPlacement.width), 33);
  assert.equal(Math.round(canvas._brandLayoutPlacement.height), 67);
  assert.equal(Math.round(calls.at(-1).at(-2)), 33);
  config.widthPercent = 78;
  context.drawBrandedLayout(base, null, canvas, config, {}, "cian");
  assert.equal(Math.round(canvas._brandLayoutPlacement.width), 69);
  assert.equal(Math.round(canvas._brandLayoutPlacement.height), 137);
});

test("editor uses the rendered plan placement and does not add a second stale outline", () => {
  assert.match(layoutEditor, /if\(brandPreviewPlacement\)return \{\.\.\.brandPreviewPlacement\}/);
  assert.doesNotMatch(layoutEditor, /canvas\.width\*\.78\/source\.sw/);
  assert.doesNotMatch(layoutEditor, /outline\.className = 'le-selection'/);
  assert.match(layoutEditor, /document\.querySelector\('#brandOffsetY'\)\.value=0/);
});

test("switching sources isolates objects and publication URLs, including shared objects", () => {
  const context = vm.createContext({
    activeSourceId: "a", activePlatform: "cian", selectedId: "one", checkedIds: new Set(["one"]),
    projectSources: [{ id: "a", url: "https://a.test/feed.xml", platform: "cian" }, { id: "b", url: "https://b.test/feed.xml", platform: "cian" }],
    appState: { generatedLink: "https://listingflow.test/feeds/a.xml", publishedFeeds: { a: { id: "saved-a", url: "https://listingflow.test/feeds/a.xml", history: [{ version: 1 }] } } },
    objects: [{ externalId: "one", _sourceIds: ["a"] }, { externalId: "two", _sourceIds: ["b"] }, { externalId: "shared", _sourceIds: ["a", "b"] }]
  });
  vm.runInContext(["activePublicationKey", "setSourceContext", "sourceWorkingObjects", "workingObjects"].map(clientFunction).join("\n"), context);
  context.setSourceContext("b");
  assert.equal(context.appState.generatedLink, "");
  assert.equal(context.appState.generatedFeedId, "");
  assert.equal(context.appState.feedUrl, "https://b.test/feed.xml");
  assert.equal(context.checkedIds.size, 0);
  assert.equal(context.workingObjects().map(item => item.externalId).join(","), "two,shared");
  context.setSourceContext("a");
  assert.equal(context.appState.generatedFeedId, "saved-a");
  assert.equal(context.workingObjects().length, 2);
  context.setSourceContext("removed-source");
  assert.equal(context.activeSourceId, "all");
  assert.equal(context.workingObjects().length, 3);
});

test("selecting a residential complex scopes editing and creates a separate publication context", () => {
  const context = vm.createContext({
    activeSourceId: "source-a", activeComplexKey: "", normalizeProjectName: value => String(value || "").trim().toLowerCase(),
    projectSources: [{ id: "source-a", url: "https://a.test/feed.xml", platform: "cian" }],
    objects: [
      { externalId: "alpha-1", _sourceIds: ["source-a"], complexName: "ЖК Альфа" },
      { externalId: "alpha-2", _sourceIds: ["source-a"], complexName: "ЖК Альфа" },
      { externalId: "beta-1", _sourceIds: ["source-a"], complexName: "ЖК Бета" }
    ]
  });
  vm.runInContext(["activePublicationKey", "complexKeyForObject", "sourceWorkingObjects", "workingObjects"].map(clientFunction).join("\n"), context);
  context.activeComplexKey = context.complexKeyForObject({ complexName: "ЖК Альфа" });
  assert.equal(context.activePublicationKey(), "source-a::complex::жк альфа");
  assert.deepEqual(context.workingObjects().map(item => item.externalId), ["alpha-1", "alpha-2"]);
});

test("CIAN uses branded layout as the only default image and retains the original", () => {
  const context = vm.createContext({
    objects: [], escapeXml: value => String(value).replaceAll("&", "&amp;"), cdata: value => String(value),
    photoList: item => item.photos,
    isBrandedLayoutUrl: url => url.includes("/layouts/")
  });
  vm.runInContext(clientFunction("buildCianXml"), context);
  const xml = context.buildCianXml([{ externalId: "one", layoutPhoto: "https://img.test/original.jpg", photos: ["https://img.test/layouts/branded.jpg", "https://img.test/building.jpg"] }]);
  assert.match(xml, /<LayoutPhoto>\s*<FullUrl>https:\/\/img.test\/layouts\/branded.jpg<\/FullUrl>\s*<IsDefault>1<\/IsDefault>/);
  assert.equal((xml.match(/<IsDefault>1<\/IsDefault>/g) || []).length, 1);
  assert.match(xml, /<FullUrl>https:\/\/img.test\/original.jpg<\/FullUrl>/);
});

test("imported branded layouts are not regenerated or reported as missing", () => {
  const context = vm.createContext({
    photoList: item => String(item.photos || "").split(/\n+/).filter(Boolean),
    isBrandedLayoutUrl: url => /branded-|planirovka-na-podlozhke-/i.test(String(url))
  });
  vm.runInContext(clientFunction("hasBrandedLayout"), context);
  assert.equal(context.hasBrandedLayout({ layoutPhoto: "https://feeds.test/layouts/branded-42.jpg", photos: "" }), true);
  assert.equal(context.hasBrandedLayout({ layoutPhoto: "https://img.test/original.jpg", photos: "https://feeds.test/layouts/branded-42.jpg" }), true);
  assert.equal(context.hasBrandedLayout({ layoutPhoto: "https://img.test/original.jpg", photos: "https://img.test/flat.jpg" }), false);
  assert.match(html, /item\.layoutPhoto && !hasBrandedLayout\(item\)/);
  assert.doesNotMatch(html, /item\.layoutPhoto && !photoList\(item\)\.some\(isBrandedLayoutUrl\)/);
});

test("publication records URL sources, manual objects and explicit exclusions separately", () => {
  const context = vm.createContext({
    activeSourceId: "all",
    projectSources: [
      { id: "url-a", url: "https://a.test/feed.xml", excludedObjectIds: ["hidden-before"] },
      { id: "file-b", url: "upload.xml" }
    ],
    originalObjects: [
      { externalId: "one", _sourceId: "url-a", _sourceIds: ["url-a"] },
      { externalId: "removed", _sourceId: "url-a", _sourceIds: ["url-a"] },
      { externalId: "file-one", _sourceId: "file-b", _sourceIds: ["file-b"] }
    ]
  });
  vm.runInContext(clientFunction("publicationSourceFeeds"), context);
  const result = context.publicationSourceFeeds([
    { externalId: "one", _sourceId: "url-a", _sourceIds: ["url-a"] },
    { externalId: "file-one", _sourceId: "file-b", _sourceIds: ["file-b"] },
    { externalId: "manual-copy" }
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].sourceType, "url");
  assert.deepEqual([...result[0].objectIds], ["one"]);
  assert.deepEqual([...result[0].excludedObjectIds], ["hidden-before", "removed"]);
  assert.equal(result[1].sourceType, "file");
  assert.deepEqual([...result[1].objectIds], ["file-one"]);
});

test("publication URLs stay stable, history versions do not repeat, and project filters isolate records", async t => {
  const os = require("node:os");
  const http = require("node:http");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "listingflow-upstream-test-"));
  Object.assign(process.env, { DATA_DIR: dataDir, APP_MODE: "internal", AUTH_USERNAME: "integration-test", AUTH_PASSWORD: "integration-test-only", AUTH_SECRET: "integration-test-only-secret", BLOB_READ_WRITE_TOKEN: "", VERCEL: "", PUBLIC_BASE_URL: "http://localhost", TELEGRAM_BOT_TOKEN: "" });
  const server = http.createServer(require("./server"));
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/auth-login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "integration-test", password: "integration-test-only" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  async function request(route, method = "GET", body) {
    const response = await fetch(base + route, { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok, `${method} ${route}: ${response.status}`);
    return response.json();
  }
  const payload = { projectId: "project-a", sourceId: "source-a", name: "Test", slug: "same-name", platform: "cian", sourceUrl: "", sourceType: "file", objectCount: 1, xml: "<feed><object><ExternalId>1</ExternalId><Description>Test apartment description</Description><Address>Test address</Address><BargainTerms><Price>5000000</Price></BargainTerms></object></feed>" };
  const first = await request("/api/feeds", "POST", payload);
  assert.equal(first.contextKey, "source-a");
  const complex = await request("/api/feeds", "POST", { ...payload, slug: "test-alpha", name: "Test · ЖК Альфа", contextKey: "source-a::complex::жк альфа", complexName: "ЖК Альфа" });
  assert.notEqual(complex.id, first.id);
  assert.equal(complex.contextKey, "source-a::complex::жк альфа");
  assert.equal(complex.complexName, "ЖК Альфа");
  const second = await request(`/api/feeds?slug=${first.id}`, "PUT", { ...payload, xml: payload.xml.replace("5000000", "5100000") });
  assert.equal(second.url, first.url);
  assert.equal(second.history.length, 2);
  assert.equal(second.releases.length, 2);
  await request(`/api/feeds/${first.id}/history/2`, "DELETE");
  const third = await request(`/api/feeds?slug=${first.id}`, "PUT", payload);
  assert.equal(third.history[0].version, 3);
  const other = await request("/api/feeds", "POST", { ...payload, projectId: "project-b", sourceId: "source-b" });
  assert.notEqual(other.id, first.id);
  assert.equal(other.history.length, 1);
  assert.equal(other.releases.length, 1);
  assert.equal(other.history[0].version, 1);
  const renamed = await request(`/api/feeds/${first.id}/name`, "PATCH", { name: "Основной фид ЦИАН" });
  assert.equal(renamed.name, "Основной фид ЦИАН");
  const filtered = await request("/api/feeds?projectId=project-a");
  assert.deepEqual(filtered.feeds.map(item => item.id).sort(), [complex.id, first.id].sort());
  const filteredFirst = filtered.feeds.find(item => item.id === first.id);
  assert.equal(filteredFirst.sourceId, "source-a");
  assert.equal(filteredFirst.name, "Основной фид ЦИАН");
});
