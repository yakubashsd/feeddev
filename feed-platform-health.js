"use strict";

const PLATFORM_LABELS = {
  cian: "ЦИАН",
  avito: "Авито",
  yandex: "Яндекс Недвижимость",
  "yandex-real-estate": "Яндекс Недвижимость"
};

function normalizeStatus(feed = {}) {
  const importStatus = String(feed.lastImportStatus || "").toLowerCase();
  if (importStatus === "blocked") return "blocked";
  if (feed.autoSyncError || feed.lastImportError || importStatus === "failed" || importStatus === "error") return "error";
  if (feed.feedStale || feed.stale) return "stale";
  if (feed.lastImportSuccessAt || feed.lastSuccessAt || importStatus === "success") return "healthy";
  return "pending";
}

function platformHealthMatrix(feeds = [], { projectId = "" } = {}) {
  return feeds
    .filter(feed => !projectId || String(feed.projectId || "") === String(projectId))
    .map(feed => {
      const platform = String(feed.platform || "auto").trim().toLowerCase();
      const status = normalizeStatus(feed);
      return {
        feedId: feed.id || feed.slug || "",
        sourceId: feed.sourceId || "",
        name: feed.name || "Без названия",
        platform,
        platformLabel: PLATFORM_LABELS[platform] || platform || "Площадка",
        status,
        objectCount: Number(feed.objectCount || 0),
        lastGoodObjectCount: Number(feed.lastGoodObjectCount ?? feed.objectCount ?? 0),
        lastSourceObjectCount: Number(feed.lastSourceObjectCount ?? feed.objectCount ?? 0),
        lastImportStatus: feed.lastImportStatus || "unknown",
        lastImportAttemptAt: feed.lastImportAttemptAt || null,
        lastImportSuccessAt: feed.lastImportSuccessAt || feed.lastSuccessAt || feed.lastAutoSyncAt || null,
        nextRunAt: feed.nextRunAt || feed.nextAutoSyncAt || null,
        error: feed.lastImportError || feed.autoSyncError || "",
        warning: feed.lastImportWarning || "",
        stale: Boolean(feed.feedStale || feed.stale)
      };
    })
    .sort((a, b) => `${a.platformLabel} ${a.name}`.localeCompare(`${b.platformLabel} ${b.name}`, "ru"));
}

module.exports = { PLATFORM_LABELS, normalizeStatus, platformHealthMatrix };
