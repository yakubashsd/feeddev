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

function recordRooms(xml) {
  return normalizeId(textTag(xml, ["FlatRoomsCount", "Rooms", "rooms", "room-count", "roomCount"]));
}

function recordComplex(xml) {
  return normalizeId(textTag(xml, ["ComplexName", "building-name", "BuildingName", "Name"]));
}

function records(xml) {
  const result = [];
  const matcher = /<(Ad|offer|object)\b[^>]*>[\s\S]*?<\/\1>/gi;
  for (const match of String(xml).matchAll(matcher)) {
    result.push({
      id: recordId(match[0]),
      price: recordPrice(match[0]),
      rooms: recordRooms(match[0]),
      complex: recordComplex(match[0]),
      block: match[0],
      tag: match[1],
      index: match.index,
      end: match.index + match[0].length
    });
  }
  return result;
}

function roomPolicyKey(value = "") {
  const normalized = normalizeId(value).toLowerCase();
  if (!normalized || normalized.includes("студ")) return normalized.includes("студ") ? "studio" : "unknown";
  const number = normalized.match(/\d+(?:[.,]\d+)?/)?.[0];
  return number ? String(Number(number.replace(",", "."))) : normalized;
}

function trafficPolicyExcludedIds(items = [], policy = {}) {
  if (!["one-per-room", "one-per-complex-room"].includes(policy?.mode)) return [];
  const groups = new Map();
  for (const item of items) {
    if (!item.id) continue;
    const roomKey = roomPolicyKey(item.rooms);
    const key = policy.mode === "one-per-complex-room" ? `${roomPolicyKey(item.complex)}::${roomKey}` : roomKey;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const selections = policy?.selections && typeof policy.selections === "object" ? policy.selections : {};
  const excluded = [];
  for (const [key, group] of groups) {
    const selectedId = normalizeId(selections[key] || "");
    const keep = group.find(item => item.id === selectedId) || group[0];
    group.forEach(item => { if (item.id !== keep.id) excluded.push(item.id); });
  }
  return [...new Set(excluded)];
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
  const closingTag = tag.toLowerCase() === "ad" ? "Ads" : tag.toLowerCase() === "offer" ? "realty-feed" : "feed";
  const matcher = new RegExp(`</${closingTag}\\s*>`, "i");
  const match = matcher.exec(xml);
  if (!match) return xml;
  const separator = xml.slice(0, match.index).endsWith("\n") ? "" : "\n";
  return `${xml.slice(0, match.index)}${separator}${blocks.join("\n")}\n${xml.slice(match.index)}`;
}

/**
 * Keeps user-edited fields in the published XML, while the source remains
 * authoritative for prices and for the set of source-managed objects.
 */
function synchronizeFeed(publishedXml, sourceXmls, options = {}) {
  const sources = (Array.isArray(sourceXmls) ? sourceXmls : [sourceXmls]).map(records);
  const sourceRecords = sources.flat();
  const publishedRecords = records(publishedXml);
  const sourceById = new Map(sourceRecords.filter(item => item.id).map(item => [item.id, item]));
  const publishedById = new Map(publishedRecords.filter(item => item.id).map(item => [item.id, item]));
  const excludedIds = new Set((options.excludedIds || []).map(normalizeId).filter(Boolean));
  const managedIds = new Set((options.managedIds || publishedRecords.map(item => item.id)).map(normalizeId).filter(Boolean));
  const invalidSourceRecords = sourceRecords.filter(item => !item.id || !item.price).length;
  const sourceDuplicateIds = duplicateIds(sourceRecords);
  const publishedDuplicateIds = duplicateIds(publishedRecords);
  let checked = 0;
  let updated = 0;
  let removed = 0;
  let cursor = 0;
  const pieces = [];

  for (const item of publishedRecords) {
    pieces.push(String(publishedXml).slice(cursor, item.index));
    cursor = item.end;
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
    } else {
      pieces.push(item.block);
    }
  }
  pieces.push(String(publishedXml).slice(cursor));

  const addedRecords = [...sourceById.values()].filter(item => item.price && !publishedById.has(item.id) && !excludedIds.has(item.id));
  const publishedTag = publishedRecords[0]?.tag || sourceRecords[0]?.tag || "";
  const xml = insertBeforeRootClose(pieces.join(""), addedRecords.map(item => item.block), publishedTag);
  return {
    xml,
    checked,
    updated,
    added: addedRecords.length,
    removed,
    sourceCount: sourceById.size,
    outputCount: records(xml).length,
    invalidSourceRecords,
    sourceDuplicateIds,
    publishedDuplicateIds,
    sourceIds: [...sourceById.keys()]
  };
}

function synchronizePrices(publishedXml, sourceXml) {
  const sourcePrices = new Map(records(sourceXml).filter(item => item.id && item.price).map(item => [item.id, item.price]));
  let checked = 0;
  let updated = 0;
  const xml = String(publishedXml).replace(/<(Ad|offer|object)\b[^>]*>[\s\S]*?<\/\1>/gi, block => {
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

module.exports = { records, synchronizeFeed, synchronizePrices, roomPolicyKey, trafficPolicyExcludedIds };
