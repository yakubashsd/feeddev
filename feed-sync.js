"use strict";

function decodeXml(value = "") {
  return String(value)
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .trim();
}

function normalizeId(value = "") {
  return decodeXml(value).trim();
}

function normalizePrice(value = "") {
  const compact = decodeXml(value).replace(/\s+/g, "").replace(/,/g, ".");
  return /^\d+(?:\.\d+)?$/.test(compact) ? compact : "";
}

function textTag(xml, names) {
  for (const name of names) {
    const match = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
    if (match) return decodeXml(match[1].replace(/<[^>]+>/g, ""));
  }
  return "";
}

function recordId(xml) {
  return normalizeId(
    textTag(xml, ["ExternalId", "external-id", "Id", "id"])
    || xml.match(/\b(?:internal-id|id)=["']([^"']+)["']/i)?.[1]
    || ""
  );
}

function recordPrice(xml) {
  const attribute = xml.match(/<price\b[^>]*\bvalue=["']([^"']+)["'][^>]*\/?\s*>/i)?.[1];
  return normalizePrice(attribute || textTag(xml, ["Price", "price"]));
}

function records(xml) {
  const result = [];
  const matcher = /<(Ad|offer|Offer|object)\b[^>]*>[\s\S]*?<\/\1>/gi;
  for (const match of String(xml).matchAll(matcher)) {
    const id = recordId(match[0]);
    const price = recordPrice(match[0]);
    if (id && price) result.push({ id, price, block: match[0], tag: match[1], index: match.index, end: match.index + match[0].length });
  }
  return result;
}

function replacePrice(block, price) {
  const escaped = String(price);
  if (/<price\b[^>]*\bvalue=["']/i.test(block)) {
    return block.replace(/(<price\b[^>]*\bvalue=["'])[^"']*(["'][^>]*\/?\s*>)/i, `$1${escaped}$2`);
  }
  if (/<price\b[^>]*>[\s\S]*?<value\b[^>]*>/i.test(block)) {
    return block.replace(/(<value\b[^>]*>)[\s\S]*?(<\/value>)/i, `$1${escaped}$2`);
  }
  return block.replace(/(<(?:Price|price)\b[^>]*>)[\s\S]*?(<\/(?:Price|price)>)/i, `$1${escaped}$2`);
}

function duplicateIds(items) {
  const seen = new Set();
  const duplicates = new Set();
  for (const item of items) {
    if (!item.id) continue;
    if (seen.has(item.id)) duplicates.add(item.id);
    seen.add(item.id);
  }
  return [...duplicates];
}

function insertBeforeRootClose(xml, blocks, tag) {
  if (!blocks.length) return xml;
  const root = tag.toLowerCase() === "ad" ? "Ads" : tag.toLowerCase() === "offer" ? "realty-feed" : "feed";
  const match = new RegExp(`</${root}\\s*>`, "i").exec(xml);
  if (!match) return xml;
  const separator = xml.slice(0, match.index).endsWith("\\n") ? "" : "\\n";
  return `${xml.slice(0, match.index)}${separator}${blocks.join("\\n")}\\n${xml.slice(match.index)}`;
}

function synchronizeFeed(publishedXml, sourceXml, options = {}) {
  const sourceRecords = records(sourceXml);
  const publishedRecords = records(publishedXml);
  const sourceById = new Map(sourceRecords.map(item => [item.id, item]));
  const publishedById = new Map(publishedRecords.map(item => [item.id, item]));
  const excludedIds = new Set((options.excludedIds || []).map(normalizeId).filter(Boolean));
  const managedIds = new Set((options.managedIds || publishedRecords.map(item => item.id)).map(normalizeId).filter(Boolean));
  let checked = 0;
  let updated = 0;
  let added = 0;
  let removed = 0;
  let cursor = 0;
  const pieces = [];
  for (const item of publishedRecords) {
    pieces.push(String(publishedXml).slice(cursor, item.index));
    cursor = item.index + item.block.length;
    if (!item.id || excludedIds.has(item.id)) {
      if (item.id && excludedIds.has(item.id)) removed += 1;
      else pieces.push(item.block);
      continue;
    }
    const source = sourceById.get(item.id);
    if (!source && managedIds.has(item.id)) {
      removed += 1;
      continue;
    }
    if (!source) {
      pieces.push(item.block);
      continue;
    }
    checked += 1;
    if (source.price !== item.price) {
      updated += 1;
      pieces.push(replacePrice(item.block, source.price));
    } else pieces.push(item.block);
  }
  pieces.push(String(publishedXml).slice(cursor));
  const addedRecords = sourceRecords.filter(item => item.price && !publishedById.has(item.id) && !excludedIds.has(item.id));
  const tag = publishedRecords[0]?.tag || sourceRecords[0]?.tag || "";
  const xml = insertBeforeRootClose(pieces.join(""), addedRecords.map(item => item.block), tag);
  added = addedRecords.length;
  return { xml, checked, updated, added, removed, sourceCount: sourceById.size, outputCount: records(xml).length };
}

function synchronizePrices(publishedXml, sourceXml) {
  const sourcePrices = new Map(records(sourceXml).filter(item => item.id && item.price).map(item => [item.id, item.price]));
  let checked = 0;
  let updated = 0;
  const xml = String(publishedXml).replace(/<(Ad|offer|Offer|object)\b[^>]*>[\s\S]*?<\/\1>/gi, block => {
    const id = recordId(block);
    if (!id) return block;
    checked += 1;
    const price = sourcePrices.get(id);
    if (!price || recordPrice(block) === price) return block;
    updated += 1;
    return replacePrice(block, price);
  });
  return { xml, checked, updated, sourceCount: sourcePrices.size };
}

module.exports = { records, synchronizeFeed, synchronizePrices };
