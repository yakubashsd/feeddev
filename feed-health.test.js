"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { countDrop, feedTransition, healthSnapshot } = require("./feed-health");

test("feed health measures a meaningful count drop", () => {
  assert.equal(countDrop(1000, 750), 25);
  assert.equal(countDrop(1000, 1200), 0);
  assert.equal(feedTransition(100, 0).blocked, true);
  assert.equal(feedTransition(100, 10).blocked, false);
  assert.equal(feedTransition(100, 10).warning, "");
});

test("health snapshots keep the source and output counts for diagnostics", () => {
  const snapshot = healthSnapshot({
    status: "healthy",
    previousCount: 12,
    currentCount: 14,
    summary: { checked: 12, updated: 3, added: 2, removed: 0, sourceCount: 14, outputCount: 14 }
  });
  assert.equal(snapshot.status, "healthy");
  assert.equal(snapshot.previousCount, 12);
  assert.equal(snapshot.currentCount, 14);
  assert.deepEqual(snapshot.summary, { checked: 12, updated: 3, added: 2, removed: 0, sourceCount: 14, outputCount: 14 });
});
