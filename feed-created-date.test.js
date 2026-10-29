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

test("project summaries expose the freshest server sync date without replacing creation date", () => {
  assert.match(server, /const sourceFeedRecords = projectFeeds\.filter\(feed =>/);
  assert.match(server, /const newestTimestamp = \(\.\.\.values\) => values/);
  assert.match(server, /lastImportSuccessAt = newestTimestamp\([\s\S]*?latestSourceFeed\?\.lastImportSuccessAt/);
  assert.match(server, /updatedAt = newestTimestamp\(source\.updatedAt, lastImportSuccessAt, latestSourceFeed\?\.updatedAt\)/);
  assert.match(server, /createdAt: source\.createdAt \|\| null,[\s\S]*?updatedAt,[\s\S]*?lastImportSuccessAt/);
});

test("newer published sync timestamps cannot be shadowed by an older source snapshot", () => {
  const sourceSnapshot = "2026-10-26T08:16:00.000Z";
  const publishedSync = "2026-10-29T08:16:00.000Z";
  const newest = [sourceSnapshot, publishedSync]
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];
  assert.equal(newest, publishedSync);
  assert.match(server, /const lastSuccessAt = newestTimestamp\(/);
});

test("the client prefers the newest server timestamp when several feed summaries match", () => {
  assert.match(html, /const matches = summaries\.filter\(item =>/);
  assert.match(html, /timestamp = item => new Date\(item\.lastImportSuccessAt \|\| item\.lastSuccessAt \|\| item\.updatedAt/);
  assert.match(html, /function sourceLastUpdatedAt\(source, publication = \{\}\)/);
  assert.match(html, /summary\?\.lastImportSuccessAt,[\s\S]*?publication\?\.updatedAt,[\s\S]*?source\?\.updatedAt/);
  assert.match(html, /const updatedAt = sourceLastUpdatedAt\(source, publication\)/);
});
