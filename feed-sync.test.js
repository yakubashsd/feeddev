"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { synchronizeFeed, synchronizePrices } = require("./feed-sync");

test("synchronizes only matching prices and preserves other published fields", () => {
  const source = `<Ads><Ad><Id>42</Id><BargainTerms><Price>9100000</Price></BargainTerms></Ad></Ads>`;
  const published = `<Ads><Ad><Id>42</Id><Description>Edited by manager</Description><BargainTerms><Price>8900000</Price></BargainTerms></Ad><Ad><Id>77</Id><BargainTerms><Price>5000000</Price></BargainTerms></Ad></Ads>`;
  const result = synchronizePrices(published, source);
  assert.equal(result.updated, 1);
  assert.match(result.xml, /<Description>Edited by manager<\/Description>/);
  assert.match(result.xml, /<Id>42<\/Id>[\s\S]*?<Price>9100000<\/Price>/);
  assert.match(result.xml, /<Id>77<\/Id>[\s\S]*?<Price>5000000<\/Price>/);
});

test("adds new source objects, updates prices, and removes missing managed objects", () => {
  const source = `<Ads><Ad><Id>42</Id><BargainTerms><Price>9100000</Price></BargainTerms></Ad><Ad><Id>99</Id><BargainTerms><Price>7200000</Price></BargainTerms></Ad></Ads>`;
  const published = `<Ads><Ad><Id>42</Id><Description>Edited</Description><BargainTerms><Price>8900000</Price></BargainTerms></Ad><Ad><Id>77</Id><BargainTerms><Price>5000000</Price></BargainTerms></Ad></Ads>`;
  const result = synchronizeFeed(published, source);
  assert.equal(result.updated, 1);
  assert.equal(result.added, 1);
  assert.equal(result.removed, 1);
  assert.match(result.xml, /<Id>99<\/Id>/);
  assert.doesNotMatch(result.xml, /<Id>77<\/Id>/);
  assert.match(result.xml, /<Description>Edited<\/Description>/);
});
