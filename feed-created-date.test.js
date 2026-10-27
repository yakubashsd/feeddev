"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "feed-generator.html"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

test("feed cards render the server-backed creation date", () => {
  assert.match(html, /function formatFeedDate\(value/);
  assert.match(html, /class="overview-feed-created">Создан:/);
  assert.match(html, /createdAt: existingSource\?\.createdAt \|\| new Date\(\)\.toISOString\(\)/);
  assert.match(html, /createdAt: importedAt/);
});

test("project summaries expose creation dates for sources and published feeds", () => {
  assert.match(server, /createdAt: source\.createdAt \|\| null/);
  assert.match(server, /createdAt: feed\.createdAt \|\| null/);
});
