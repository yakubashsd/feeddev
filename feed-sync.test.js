"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { synchronizeFeed, synchronizePrices, trafficPolicyExcludedIds } = require("./feed-sync");

test("synchronizes only matching prices and preserves other published fields", () => {
  const source = `<Ads><Ad><Id>42</Id><BargainTerms><Price>9100000</Price></BargainTerms></Ad></Ads>`;
  const published = `<Ads><Ad><Id>42</Id><Description>Edited by manager</Description><BargainTerms><Price>8900000</Price></BargainTerms></Ad><Ad><Id>77</Id><BargainTerms><Price>5000000</Price></BargainTerms></Ad></Ads>`;
  const result = synchronizePrices(published, source);
  assert.equal(result.updated, 1);
  assert.match(result.xml, /<Description>Edited by manager<\/Description>/);
  assert.match(result.xml, /<Id>42<\/Id>[\s\S]*?<Price>9100000<\/Price>/);
  assert.match(result.xml, /<Id>77<\/Id>[\s\S]*?<Price>5000000<\/Price>/);
});

test("synchronizes source prices and object membership without replacing user edits", () => {
  const source = `<feed>
    <object><ExternalId>42</ExternalId><Description>Source description</Description><Address>Source address</Address><BargainTerms><Price>9100000</Price></BargainTerms></object>
    <object><ExternalId>99</ExternalId><Description>New apartment</Description><Address>New address</Address><BargainTerms><Price>6200000</Price></BargainTerms></object>
  </feed>`;
  const published = `<feed>
    <object><ExternalId>42</ExternalId><Description>Edited by manager</Description><Address>Edited address</Address><BargainTerms><Price>8900000</Price></BargainTerms></object>
    <object><ExternalId>77</ExternalId><Description>Removed upstream</Description><Address>Old address</Address><BargainTerms><Price>5000000</Price></BargainTerms></object>
    <object><ExternalId>manual-copy</ExternalId><Description>Created in ListingFlow</Description><Address>Manual address</Address><BargainTerms><Price>7000000</Price></BargainTerms></object>
  </feed>`;
  const result = synchronizeFeed(published, source, { managedIds: ["42", "77"] });
  assert.equal(result.updated, 1);
  assert.equal(result.added, 1);
  assert.equal(result.removed, 1);
  assert.equal(result.outputCount, 3);
  assert.match(result.xml, /<ExternalId>42<\/ExternalId><Description>Edited by manager<\/Description><Address>Edited address<\/Address>[\s\S]*?<Price>9100000<\/Price>/);
  assert.doesNotMatch(result.xml, /<ExternalId>77<\/ExternalId>/);
  assert.match(result.xml, /<ExternalId>99<\/ExternalId>/);
  assert.match(result.xml, /<ExternalId>manual-copy<\/ExternalId>/);
});

test("excluded source objects stay excluded and additions work for Avito", () => {
  const source = `<Ads><Ad><Id>one</Id><Description>One</Description><Address>A</Address><Price>10</Price></Ad><Ad><Id>two</Id><Description>Two</Description><Address>B</Address><Price>20</Price></Ad></Ads>`;
  const published = `<Ads><Ad><Id>one</Id><Description>Edited one</Description><Address>A</Address><Price>9</Price></Ad></Ads>`;
  const result = synchronizeFeed(published, source, { managedIds: ["one"], excludedIds: ["two"] });
  assert.equal(result.updated, 1);
  assert.equal(result.added, 0);
  assert.equal(result.outputCount, 1);
  assert.match(result.xml, /<Description>Edited one<\/Description>/);
  assert.match(result.xml, /<Price>10<\/Price>/);
  assert.doesNotMatch(result.xml, /<Id>two<\/Id>/);
});

test("Yandex offers keep edited text while source controls price and membership", () => {
  const source = `<realty-feed><offer internal-id="a"><description>Source A</description><location><address>A</address></location><price><value>120</value></price></offer><offer internal-id="b"><description>Source B</description><location><address>B</address></location><price><value>200</value></price></offer></realty-feed>`;
  const published = `<realty-feed><offer internal-id="a"><description>Edited A</description><location><address>Edited address</address></location><price><value>100</value></price></offer><offer internal-id="old"><description>Old</description><location><address>Old</address></location><price><value>50</value></price></offer></realty-feed>`;
  const result = synchronizeFeed(published, source, { managedIds: ["a", "old"] });
  assert.equal(result.updated, 1);
  assert.equal(result.added, 1);
  assert.equal(result.removed, 1);
  assert.match(result.xml, /internal-id="a"[\s\S]*?<description>Edited A<\/description>[\s\S]*?<value>120<\/value>/);
  assert.match(result.xml, /internal-id="b"/);
  assert.doesNotMatch(result.xml, /internal-id="old"/);
});

test("one-per-room traffic policy keeps a chosen representative and applies to new objects", () => {
  const source = `<feed>
    <object><ExternalId>one-a</ExternalId><FlatRoomsCount>1</FlatRoomsCount><Description>A</Description><Address>A</Address><BargainTerms><Price>100</Price></BargainTerms></object>
    <object><ExternalId>one-b</ExternalId><FlatRoomsCount>1</FlatRoomsCount><Description>B</Description><Address>B</Address><BargainTerms><Price>110</Price></BargainTerms></object>
    <object><ExternalId>two-a</ExternalId><FlatRoomsCount>2</FlatRoomsCount><Description>C</Description><Address>C</Address><BargainTerms><Price>200</Price></BargainTerms></object>
  </feed>`;
  const published = `<feed><object><ExternalId>one-a</ExternalId><Description>Edited</Description><Address>A</Address><BargainTerms><Price>90</Price></BargainTerms></object><object><ExternalId>two-a</ExternalId><Description>C</Description><Address>C</Address><BargainTerms><Price>190</Price></BargainTerms></object></feed>`;
  const records = require("./feed-sync").records(source);
  assert.deepEqual(trafficPolicyExcludedIds(records, { mode: "one-per-room", selections: { "1": "one-b" } }), ["one-a"]);
  const result = synchronizeFeed(published, source, { managedIds: ["one-a", "two-a"], excludedIds: trafficPolicyExcludedIds(records, { mode: "one-per-room", selections: { "1": "one-b" } }) });
  assert.equal(result.outputCount, 2);
  assert.doesNotMatch(result.xml, /one-a/);
  assert.match(result.xml, /one-b/);
  assert.match(result.xml, /two-a/);
});

test("one-per-complex-room policy keeps one representative inside each ЖК", () => {
  const source = `<feed><object><ExternalId>a1</ExternalId><Name>Солнечный</Name><FlatRoomsCount>1</FlatRoomsCount><Price>10</Price></object><object><ExternalId>a2</ExternalId><Name>Солнечный</Name><FlatRoomsCount>1</FlatRoomsCount><Price>11</Price></object><object><ExternalId>b1</ExternalId><Name>Речной</Name><FlatRoomsCount>1</FlatRoomsCount><Price>12</Price></object></feed>`;
  const { records, trafficPolicyExcludedIds } = require("./feed-sync");
  assert.deepEqual(trafficPolicyExcludedIds(records(source), { mode: "one-per-complex-room" }), ["a2"]);
});
