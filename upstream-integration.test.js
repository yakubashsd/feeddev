"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const html = fs.readFileSync(path.join(__dirname, "feed-generator.html"), "utf8");

function clientFunction(name) {
  const start = html.indexOf(`    function ${name}(`);
  assert.notEqual(start, -1, name);
  const rest = html.slice(start);
  const end = rest.slice(5).search(/\n    (?:async )?function /);
  return rest.slice(0, end + 5);
}

test("client scripts remain syntactically valid after integrating both branches", () => {
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
});

test("external clients always hydrate the server project state without a local-version prompt", () => {
  const hydrate = html.match(/    async function hydrateExternalProjectState\([\s\S]*?\n    }\n\n    async function renderBillingPayments/)[0];
  const push = html.match(/    async function pushExternalProjectState\([\s\S]*?\n    }\n\n    let projectStateSyncTimer/)[0];
  assert.doesNotMatch(hydrate, /confirm\(/);
  assert.doesNotMatch(hydrate, /pushExternalProjectState\(/);
  assert.match(hydrate, /for \(const key of projectStateKeys\(\)\) localStorage\.removeItem\(key\)/);
  assert.doesNotMatch(push, /const useLocal = confirm/);
  assert.match(push, /Загружаем сохранённую версию проекта/);
});

test("switching sources isolates objects and publication URLs, including shared objects", () => {
  const context = vm.createContext({
    activeSourceId: "a", activePlatform: "cian", selectedId: "one", checkedIds: new Set(["one"]),
    projectSources: [{ id: "a", url: "https://a.test/feed.xml", platform: "cian" }, { id: "b", url: "https://b.test/feed.xml", platform: "cian" }],
    appState: { generatedLink: "https://listingflow.test/feeds/a.xml", publishedFeeds: { a: { id: "saved-a", url: "https://listingflow.test/feeds/a.xml", history: [{ version: 1 }] } } },
    objects: [{ externalId: "one", _sourceIds: ["a"] }, { externalId: "two", _sourceIds: ["b"] }, { externalId: "shared", _sourceIds: ["a", "b"] }]
  });
  vm.runInContext(["activePublicationKey", "setSourceContext", "workingObjects"].map(clientFunction).join("\n"), context);
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
  assert.deepEqual(filtered.feeds.map(item => item.id), [first.id]);
  assert.equal(filtered.feeds[0].sourceId, "source-a");
  assert.equal(filtered.feeds[0].name, "Основной фид ЦИАН");
});
