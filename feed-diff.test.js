"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { diffFeeds } = require("./feed-diff");

test("feed diff reports added, removed and price-changed objects", () => {
  const previous = `<feed><object><ExternalId>a</ExternalId><BargainTerms><Price>10</Price></BargainTerms></object><object><ExternalId>b</ExternalId><BargainTerms><Price>20</Price></BargainTerms></object></feed>`;
  const next = `<feed><object><ExternalId>a</ExternalId><BargainTerms><Price>12</Price></BargainTerms></object><object><ExternalId>c</ExternalId><BargainTerms><Price>30</Price></BargainTerms></object></feed>`;
  assert.deepEqual(diffFeeds(previous, next), {
    previousCount: 2,
    nextCount: 2,
    addedCount: 1,
    removedCount: 1,
    changedPriceCount: 1,
    addedIds: ["c"],
    removedIds: ["b"],
    changedPriceIds: ["a"],
    hasChanges: true
  });
});
