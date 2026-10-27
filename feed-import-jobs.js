"use strict";

const crypto = require("node:crypto");

function createFeedImportJobs({ download, concurrency = 2, ttlMs = 30 * 60 * 1000 } = {}) {
  if (typeof download !== "function") throw new TypeError("download function is required");
  const jobs = new Map();
  const queue = [];
  let active = 0;

  const publicJob = job => {
    if (!job) return null;
    return {
      id: job.id,
      status: job.status,
      progress: job.progress,
      sourceUrl: job.sourceUrl,
      createdAt: job.createdAt,
      startedAt: job.startedAt || null,
      finishedAt: job.finishedAt || null,
      error: job.error || "",
      xml: job.status === "completed" ? job.xml : undefined
    };
  };

  const pump = () => {
    while (active < Math.max(1, Number(concurrency) || 1) && queue.length) {
      const id = queue.shift();
      const job = jobs.get(id);
      if (!job || job.status !== "queued") continue;
      active += 1;
      run(job).finally(() => {
        active -= 1;
        pump();
      });
    }
  };

  async function run(job) {
    if (job.cancelRequested) {
      job.status = "canceled";
      job.finishedAt = new Date().toISOString();
      return;
    }
    job.status = "running";
    job.progress = 15;
    job.startedAt = new Date().toISOString();
    try {
      const result = await download(job.sourceUrl, { signal: job.controller.signal });
      if (job.cancelRequested || job.controller.signal.aborted) {
        job.status = "canceled";
        job.progress = 0;
        return;
      }
      job.xml = String(result || "");
      job.status = "completed";
      job.progress = 100;
    } catch (error) {
      if (job.cancelRequested || job.controller.signal.aborted) {
        job.status = "canceled";
        job.progress = 0;
      } else {
        job.status = "failed";
        job.error = error?.message || "Не удалось загрузить XML-фид.";
        job.progress = 100;
      }
    } finally {
      job.finishedAt = new Date().toISOString();
      job.controller = null;
    }
  }

  function create(sourceUrl, ownerId = "") {
    const normalizedUrl = String(sourceUrl || "").trim();
    const parsed = new URL(normalizedUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("Нужна HTTP(S)-ссылка без логина и пароля");
    if (parsed.username || parsed.password) throw new Error("Ссылка не должна содержать логин и пароль");
    const now = new Date().toISOString();
    const job = {
      id: crypto.randomUUID(),
      ownerId: String(ownerId || ""),
      sourceUrl: normalizedUrl,
      status: "queued",
      progress: 0,
      createdAt: now,
      startedAt: "",
      finishedAt: "",
      error: "",
      xml: "",
      cancelRequested: false,
      controller: new AbortController()
    };
    jobs.set(job.id, job);
    queue.push(job.id);
    pump();
    return publicJob(job);
  }

  function get(id, ownerId = "") {
    const job = jobs.get(String(id || ""));
    if (!job || job.ownerId !== String(ownerId || "")) return null;
    return publicJob(job);
  }

  function cancel(id, ownerId = "") {
    const job = jobs.get(String(id || ""));
    if (!job || job.ownerId !== String(ownerId || "")) return null;
    if (["completed", "failed", "canceled"].includes(job.status)) return publicJob(job);
    job.cancelRequested = true;
    job.status = "canceled";
    job.progress = 0;
    job.finishedAt = new Date().toISOString();
    job.controller?.abort();
    return publicJob(job);
  }

  const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - ttlMs;
    for (const [id, job] of jobs) {
      const timestamp = Date.parse(job.finishedAt || job.createdAt);
      if (Number.isFinite(timestamp) && timestamp < cutoff && ["completed", "failed", "canceled"].includes(job.status)) jobs.delete(id);
    }
  }, Math.min(ttlMs, 5 * 60 * 1000));
  cleanupTimer.unref?.();

  return { create, get, cancel };
}

module.exports = { createFeedImportJobs };
