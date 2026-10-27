"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { summarizeDiagnostics } = require("./feed-diagnostics");

test("feed diagnostics identify missing fields, duplicate ids and media issues", () => {
  const xml = `<Ads><Ad><Id>1</Id><Description>Есть</Description><Address>A</Address><Price>10</Price><Images><Image url="https://cdn.test/one.jpg">https://cdn.test/one.jpg</Image><Image url="https://cdn.test/one.jpg">https://cdn.test/one.jpg</Image></Images></Ad><Ad><Id>1</Id><Description></Description><Address>B</Address><Price>20</Price></Ad></Ads>`;
  const result = summarizeDiagnostics(xml, "avito");
  assert.equal(result.objectCount, 2);
  assert.ok(result.errorCount >= 2);
  assert.ok(result.warningCount >= 2);
  assert.ok(result.groups.some(group => group.code === "duplicate_id"));
  assert.ok(result.groups.some(group => group.code === "missing_photo"));
  assert.ok(result.groups.some(group => group.code === "duplicate_photo"));
});
