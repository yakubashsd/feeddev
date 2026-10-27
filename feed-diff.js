"use strict";

const { records } = require("./feed-sync");

function mapById(xml) {
  return new Map(records(xml).filter(item => item.id).map(item => [item.id, item]));
}

function diffFeeds(previousXml = "", nextXml = "") {
  const previous = mapById(previousXml);
  const next = mapById(nextXml);
  const added = [...next.keys()].filter(id => !previous.has(id));
  const removed = [...previous.keys()].filter(id => !next.has(id));
  const changedPrices = [...next.keys()].filter(id => previous.has(id) && next.get(id).price && previous.get(id).price !== next.get(id).price);
  return {
    previousCount: previous.size,
    nextCount: next.size,
    addedCount: added.length,
    removedCount: removed.length,
    changedPriceCount: changedPrices.length,
    addedIds: added.slice(0, 100),
    removedIds: removed.slice(0, 100),
    changedPriceIds: changedPrices.slice(0, 100),
    hasChanges: Boolean(added.length || removed.length || changedPrices.length)
  };
}

module.exports = { diffFeeds };
