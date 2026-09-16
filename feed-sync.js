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
  const tags = ["Ad", "offer", "Offer", "object"];
  for (const tag of tags) {
    const matcher = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
    for (const match of String(xml).matchAll(matcher)) {
      const id = recordId(match[0]);
      const price = recordPrice(match[0]);
      if (id && price) result.push({ id, price, block: match[0], index: match.index });
    }
  }
  return result;
}

function replacePrice(block, price) {
  const escaped = String(price);
  if (/<price\b[^>]*\bvalue=["']/i.test(block)) {
    return block.replace(/(<price\b[^>]*\bvalue=["'])[^"']*(["'][^>]*\/?\s*>)/i, `$1${escaped}$2`);
  }
  return block.replace(/(<(?:Price|price)\b[^>]*>)[\s\S]*?(<\/(?:Price|price)>)/i, `$1${escaped}$2`);
}

function synchronizePrices(publishedXml, sourceXml) {
  const sourcePrices = new Map(records(sourceXml).map(item => [item.id, item.price]));
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

module.exports = { synchronizePrices };
