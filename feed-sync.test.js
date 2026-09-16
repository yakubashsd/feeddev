"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { synchronizePrices } = require("./feed-sync");

test("synchronizes only matching prices and preserves other published fields", () => {
  const source = `<Ads><Ad><Id>42</Id><BargainTerms><Price>9100000</Price></BargainTerms></Ad></Ads>`;
  const published = `<Ads><Ad><Id>42</Id><Description>Edited by manager</Description><BargainTerms><Price>8900000</Price></BargainTerms></Ad><Ad><Id>77</Id><BargainTerms><Price>5000000</Price></BargainTerms></Ad></Ads>`;
  const result = synchronizePrices(published, source);
  assert.equal(result.updated, 1);
  assert.match(result.xml, /<Description>Edited by manager<\/Description>/);
  assert.match(result.xml, /<Id>42<\/Id>[\s\S]*?<Price>9100000<\/Price>/);
  assert.match(result.xml, /<Id>77<\/Id>[\s\S]*?<Price>5000000<\/Price>/);
});
