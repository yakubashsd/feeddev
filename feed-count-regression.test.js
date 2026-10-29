"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "feed-generator.html"), "utf8");
const helperSource = html.match(/    function sourceSummaryRecord\(source\) \{[\s\S]*?    \}\n\n    function sourceObjectCount\(source\) \{[\s\S]*?    \}\n/);

function countFor({ objects = [], projectSources = [], activeSourceId = "all", source, summary = null }) {
  assert.ok(helperSource, "source count helpers must remain in the client bundle");
  const context = {
    objects,
    projectSources,
    activeSourceId,
    currentProject: summary ? { summary } : null,
    sourceObjects(sourceId) {
      if (sourceId === "all") return objects;
      return objects.filter(item => (item._sourceIds || (item._sourceId ? [item._sourceId] : [])).includes(sourceId));
    }
  };
  context.source = source;
  vm.createContext(context);
  vm.runInContext(helperSource[0], context);
  return vm.runInContext("sourceObjectCount(source)", context);
}

test("feed cards use live scoped objects when source metadata is available", () => {
  const source = { id: "source-a", objectCount: 1 };
  assert.equal(countFor({
    source,
    projectSources: [source],
    objects: [{ externalId: "1", _sourceId: "source-a" }, { externalId: "2", _sourceIds: ["source-a"] }]
  }), 2);
});

test("feed cards fall back to persisted source counts after cross-browser hydration", () => {
  const source = { id: "source-a", objectCount: 57 };
  assert.equal(countFor({ source, projectSources: [source], objects: [] }), 57);
});

test("feed cards use the server summary when an older source record has no count", () => {
  const source = { id: "source-a", name: "ЦИАН МСК", objectCount: 0 };
  assert.equal(countFor({
    source,
    projectSources: [source],
    objects: [],
    summary: { sources: [{ sourceId: "source-a", name: "ЦИАН МСК", objectCount: 296 }] }
  }), 296);
});

test("legacy single-feed snapshots without source IDs still show their objects", () => {
  const source = { id: "source-a", objectCount: 0 };
  assert.equal(countFor({
    source,
    projectSources: [source],
    objects: [{ externalId: "1" }, { externalId: "2" }, { externalId: "3" }]
  }), 3);
});

test("cloud saves include the source registry when browser storage is unavailable", () => {
  assert.match(html, /const serializedSources = JSON\.stringify\(projectSources\)/);
  assert.match(html, /\[projectSourcesStorageKey\]: serializedSources/);
  assert.match(html, /let pendingProjectStateOverrides = \{\}/);
});

test("server snapshots remain readable when browser storage is full", () => {
  const source = html.match(/    function safeStorageSet\(key, value\) \{[\s\S]*?\n    \}\n\n    function save\(/)[0].replace(/\n\n    function save\($/, "");
  const values = new Map([["editor", "old"]]);
  const context = {
    projectStateMemory: new Map(), storageQuotaWarningShown: false,
    localStorage: { setItem() { const error = new Error("quota"); error.name = "QuotaExceededError"; throw error; }, getItem(key) { return values.get(key) ?? null; } },
    document: { querySelector() { return null; } }, showToast() {}
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  vm.runInContext('safeStorageSet("editor", JSON.stringify({objects:[{externalId:"1"}]}))', context);
  assert.equal(JSON.parse(context.projectStateMemory.get("editor")).objects[0].externalId, "1");
  assert.match(html, /JSON\.parse\(readProjectStateValue\(storageKey\)\)/);
  assert.match(html, /JSON\.parse\(readProjectStateValue\(projectSourcesStorageKey\)/);
});

test("legacy untagged objects remain editable only for an unambiguous single feed", () => {
  const source = html.match(/    function sourceWorkingObjects\(\) \{[\s\S]*?\n    \}/)[0];
  const context = { activeSourceId: "a", projectSources: [{ id: "a" }], objects: [{ externalId: "1" }] };
  vm.createContext(context);
  vm.runInContext(source, context);
  assert.equal(vm.runInContext("sourceWorkingObjects().length", context), 1);
  context.projectSources.push({ id: "b" });
  assert.equal(vm.runInContext("sourceWorkingObjects().length", context), 0);
});

test("URL imports run through the server job queue and can be canceled", () => {
  assert.match(html, /body: JSON\.stringify\(\{ url, async: true \}\)/);
  assert.match(html, /\/api\/feeds-import\/\$\{encodeURIComponent\(data\.id\)\}/);
  assert.match(html, /method: "DELETE", credentials: "same-origin"/);
});
