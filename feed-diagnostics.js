"use strict";

const { records } = require("./feed-sync");

const PLATFORM_RULES = {
  cian: {
    label: "ЦИАН",
    required: [
      ["ExternalId", "Идентификатор объекта"],
      ["Description", "Описание"],
      ["Address", "Адрес"],
      ["BargainTerms.Price", "Цена"]
    ],
    maxPhotos: 50
  },
  avito: {
    label: "Авито",
    required: [["Id", "Идентификатор объекта"], ["Description", "Описание"], ["Address", "Адрес"], ["Price", "Цена"]],
    maxPhotos: 50
  },
  yandex: {
    label: "Яндекс Недвижимость",
    required: [["internal-id", "Идентификатор объекта"], ["description", "Описание"], ["address", "Адрес"], ["price", "Цена"]],
    maxPhotos: 50
  }
};

function textValue(block, field) {
  if (field === "internal-id") return block.match(/\binternal-id=["']([^"']+)["']/i)?.[1]?.trim() || "";
  const names = field.split(".");
  const tag = names.at(-1);
  const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return String(match?.[1] || "").replace(/<[^>]+>/g, "").trim();
}

function imageUrls(block) {
  const urls = [];
  for (const match of block.matchAll(/<(?:Photo|Image|FullUrl|image)\b[^>]*?(?:url=["']([^"']+)["'])?[^>]*>([\s\S]*?)<\/(?:Photo|Image|FullUrl|image)>/gi)) {
    const value = String(match[1] || match[2] || "").trim();
    const url = value.match(/https?:\/\/[^\s<>"]+/i)?.[0];
    if (url) urls.push(url);
  }
  for (const match of block.matchAll(/(?:url|href)=["'](https?:\/\/[^"']+)["']/gi)) urls.push(match[1]);
  return urls;
}

function summarizeDiagnostics(xml = "", platform = "cian") {
  const rules = PLATFORM_RULES[platform] || PLATFORM_RULES.cian;
  const items = records(xml);
  const errors = [];
  const seenIds = new Map();
  const add = (code, item, field, message, severity = "error", objectIndex = item.index) => {
    if (errors.length >= 2000) return;
    errors.push({ code, severity, id: item.id || `object-${objectIndex}`, objectIndex, field, message });
  };

  for (const [index, item] of items.entries()) {
    const id = item.id || `object-${index + 1}`;
    if (item.id) {
      if (!seenIds.has(item.id)) seenIds.set(item.id, []);
      seenIds.get(item.id).push(index);
    }
    for (const [field, label] of rules.required) {
      const value = textValue(item.block, field);
      if (!value) add("missing_field", item, field, `Не заполнено поле «${label}».`, "error", index + 1);
    }
    const photos = imageUrls(item.block);
    const uniquePhotos = new Set(photos);
    if (!photos.length) add("missing_photo", item, "photos", "У объекта нет изображений.", "warning", index + 1);
    if (rules.maxPhotos && photos.length > rules.maxPhotos) add("too_many_photos", item, "photos", `Изображений: ${photos.length}. Для ${rules.label} рекомендуется не больше ${rules.maxPhotos}.`, "warning", index + 1);
    if (uniquePhotos.size !== photos.length) add("duplicate_photo", item, "photos", "В объекте повторяются ссылки на изображения.", "warning", index + 1);
  }
  for (const [id, indexes] of seenIds) {
    if (indexes.length < 2) continue;
    const item = items[indexes[0]];
    add("duplicate_id", item, "id", `Идентификатор «${id}» повторяется ${indexes.length} раз.`, "error", indexes[0] + 1);
  }
  const groups = Object.values(errors.reduce((result, item) => {
    const key = `${item.severity}:${item.code}`;
    result[key] ||= { code: item.code, severity: item.severity, count: 0, message: item.message };
    result[key].count += 1;
    return result;
  }, {}));
  return {
    platform,
    platformLabel: rules.label,
    objectCount: items.length,
    errorCount: errors.filter(item => item.severity === "error").length,
    warningCount: errors.filter(item => item.severity === "warning").length,
    groups,
    errors
  };
}

module.exports = { PLATFORM_RULES, imageUrls, summarizeDiagnostics, textValue };
