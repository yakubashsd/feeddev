const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createProjectStateStore } = require("./project-state-store");

test("project drafts are encrypted, isolated and replaced atomically", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feeddev-project-state-"));
  const userId = "4c7438b9-3e10-42fa-9790-57fb47b3012f";
  const projectId = "0d6ef389-80dd-4c94-86d9-c797ba2a7774";
  try {
    const store = createProjectStateStore({ dataDir: dir, secret: "project-secret" });
    assert.equal((await store.get(userId, projectId)).state, null);
    await Promise.all([
      store.put(userId, projectId, { draft: "first" }),
      store.put(userId, projectId, { draft: "second", count: 2 })
    ]);
    assert.deepEqual((await store.get(userId, projectId)).state, { draft: "second", count: 2 });
    // A fresh process/browser session reading the same server data directory
    // must receive the exact saved project snapshot.
    const secondSessionStore = createProjectStateStore({ dataDir: dir, secret: "project-secret" });
    assert.deepEqual((await secondSessionStore.get(userId, projectId)).state, { draft: "second", count: 2 });
    const raw = fs.readFileSync(path.join(dir, "project-state", `${userId}-${projectId}.enc`), "utf8");
    assert.equal(raw.includes("second"), false);
    assert.equal(await store.remove(userId, projectId), true);
    assert.equal((await store.get(userId, projectId)).state, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
