"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeStatus, platformHealthMatrix } = require("./feed-platform-health");

test("platform health matrix exposes a stable status per feed", () => {
  assert.equal(normalizeStatus({ lastImportStatus: "success" }), "healthy");
  assert.equal(normalizeStatus({ lastImportStatus: "blocked", lastImportError: "Нулевая версия источника" }), "blocked");
  assert.equal(normalizeStatus({ autoSyncError: "HTTP 500" }), "error");
  assert.equal(normalizeStatus({ feedStale: true }), "stale");
  assert.equal(normalizeStatus({}), "pending");

  const rows = platformHealthMatrix([
    { id: "feed-2", projectId: "p1", name: "ЦИАН", platform: "cian", lastImportStatus: "success", objectCount: 4 },
    { id: "feed-1", projectId: "p1", name: "Авито", platform: "avito", autoSyncError: "Не отвечает" },
    { id: "feed-3", projectId: "p2", name: "Другой проект", platform: "yandex", lastImportStatus: "success" }
  ], { projectId: "p1" });

  assert.deepEqual(rows.map(row => row.feedId), ["feed-1", "feed-2"]);
  assert.equal(rows[0].status, "error");
  assert.equal(rows[0].platformLabel, "Авито");
  assert.equal(rows[1].objectCount, 4);
});
