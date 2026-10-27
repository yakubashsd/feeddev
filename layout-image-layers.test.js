"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "feed-generator.html"), "utf8");
const editor = fs.readFileSync(path.join(__dirname, "layout-editor.js"), "utf8");

test("Avito cards always render a deterministic inline icon", () => {
  assert.match(html, /if \(normalized === "avito"\) return '[^']*<svg/);
  assert.doesNotMatch(html, /avito:\s*"\/assets\/aggregators\/avito\.ico"/);
  assert.doesNotMatch(html, /landing-channel-logos[^\n]*avito\.ico/);
  assert.doesNotMatch(html, /landing-channel-chart[^\n]*avito\.ico/);
});

test("layout editor supports multiple server-backed image layers", () => {
  assert.match(editor, /data-add-layer="image"/);
  assert.match(editor, /imageInput\.multiple\s*=\s*true/);
  assert.match(editor, /fetch\('\/api\/layouts'/);
  assert.match(editor, /type:'image'/);
  assert.match(html, /window\.listingFlowEnsureCanvasLayerImages/);
  assert.match(html, /layer\.type === "image"/);
});

test("external login clears stale browser state before account hydration", () => {
  assert.match(html, /function clearExternalClientSnapshot\(\)/);
  assert.match(html, /clearExternalClientSnapshot\(\);\s*updateBootStatus\("Загружаю список проектов/);
  assert.match(html, /cache:\s*"no-store"/);
  assert.doesNotMatch(html, /indexedDB\.open\("feed-generator-brand-assets"/);
});
