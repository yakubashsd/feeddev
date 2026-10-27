"use strict";

function countDrop(previousCount, currentCount) {
  const previous = Math.max(0, Number(previousCount) || 0);
  const current = Math.max(0, Number(currentCount) || 0);
  if (!previous || current >= previous) return 0;
  return Math.round(((previous - current) / previous) * 1000) / 10;
}

function feedTransition(previousCount, currentCount) {
  const previous = Math.max(0, Number(previousCount) || 0);
  const current = Math.max(0, Number(currentCount) || 0);
  const dropPercent = countDrop(previous, current);
  const blocked = previous > 0 && current === 0;
  return {
    previousCount: previous,
    currentCount: current,
    added: Math.max(0, current - previous),
    removed: Math.max(0, previous - current),
    dropPercent,
    blocked,
    warning: blocked ? "Источник вернул 0 объектов. Последняя рабочая версия сохранена." : ""
  };
}

function healthSnapshot({
  status = "healthy",
  previousCount = 0,
  currentCount = 0,
  attemptedAt = new Date().toISOString(),
  error = "",
  summary = {}
} = {}) {
  const transition = feedTransition(previousCount, currentCount);
  return {
    status,
    attemptedAt,
    previousCount: transition.previousCount,
    currentCount: transition.currentCount,
    dropPercent: transition.dropPercent,
    error: String(error || ""),
    summary: {
      checked: Number(summary.checked || 0),
      updated: Number(summary.updated || 0),
      added: Number(summary.added || 0),
      removed: Number(summary.removed || 0),
      sourceCount: Number(summary.sourceCount || currentCount || 0),
      outputCount: Number(summary.outputCount || currentCount || 0)
    }
  };
}

module.exports = { countDrop, feedTransition, healthSnapshot };
