"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createFeedImportJobs } = require("./feed-import-jobs");

function waitFor(getter, predicate, timeoutMs = 1000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const value = getter();
      if (predicate(value)) return resolve(value);
      if (Date.now() - started >= timeoutMs) return reject(new Error("Timed out waiting for import job"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

test("feed import jobs run on the server and return the XML after completion", async () => {
  const jobs = createFeedImportJobs({ download: async url => `<feed><object><ExternalId>${url}</ExternalId></object></feed>` });
  const created = jobs.create("https://example.test/feed.xml", "user-a");
  const completed = await waitFor(() => jobs.get(created.id, "user-a"), job => job.status === "completed");
  assert.equal(completed.progress, 100);
  assert.match(completed.xml, /example\.test/);
  assert.equal(jobs.get(created.id, "user-b"), null);
});

test("queued feed imports can be canceled by their owner", async () => {
  let release;
  const jobs = createFeedImportJobs({
    concurrency: 1,
    download: () => new Promise(resolve => { release = resolve; })
  });
  const first = jobs.create("https://example.test/one.xml", "user-a");
  const second = jobs.create("https://example.test/two.xml", "user-a");
  await waitFor(() => jobs.get(first.id, "user-a"), job => job.status === "running");
  assert.equal(jobs.cancel(second.id, "user-a").status, "canceled");
  release("<feed />");
  await waitFor(() => jobs.get(first.id, "user-a"), job => job.status === "completed");
  assert.equal(jobs.get(second.id, "user-a").status, "canceled");
});
