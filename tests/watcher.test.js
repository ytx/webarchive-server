import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startWatcher } from "../src/watcher.js";
import { Store } from "../src/store.js";

const ID = "01J7ZK4M3N5P6Q7R8S9T0V1W2X";

async function waitFor(check, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) {
      return;
    }
    await sleep(50);
  }
  throw new Error("timed out waiting for condition");
}

test("watcher reflects external sidecar writes, edits and deletes", async () => {
  const archiveDir = await mkdtemp(join(tmpdir(), "wa-"));
  const dir = join(archiveDir, "items", "2026", "09");
  await mkdir(dir, { recursive: true });
  const store = new Store(":memory:");
  const watcher = startWatcher({ archiveDir, machineName: "m", store, debounceMs: 50 });
  try {
    await sleep(200);
    const sidecar = (memo) => JSON.stringify({ id: ID, url: "u", title: "T", savedAt: "2026-09-03T00:00:00+09:00", savedOn: "other", memo, tags: [], updatedAt: "" });
    await writeFile(join(dir, `${ID}.json`), sidecar("first"));
    await waitFor(() => store.get(ID)?.status === "pending");
    await writeFile(join(dir, `${ID}.html`), "<html></html>");
    await waitFor(() => store.get(ID)?.status === "ok");
    await writeFile(join(dir, `${ID}.json`), sidecar("second"));
    await waitFor(() => store.get(ID)?.memo === "second");
    await writeFile(join(dir, `${ID} (conflicted copy).json`), sidecar("x"));
    await waitFor(() => store.get(ID)?.status === "conflict");
    await unlink(join(dir, `${ID} (conflicted copy).json`));
    await waitFor(() => store.get(ID)?.status === "ok");
    await unlink(join(dir, `${ID}.json`));
    await unlink(join(dir, `${ID}.html`));
    await waitFor(() => store.get(ID) === null);
  } finally {
    await watcher.close();
  }
});

test("watcher converges on the last written sidecar content under rapid successive writes", async () => {
  const archiveDir = await mkdtemp(join(tmpdir(), "wa-"));
  const dir = join(archiveDir, "items", "2026", "09");
  await mkdir(dir, { recursive: true });
  const store = new Store(":memory:");
  const id = "01J7ZK4M3N5P6Q7R8S9T0V1W3Y";
  const watcher = startWatcher({ archiveDir, machineName: "m", store, debounceMs: 50 });
  try {
    await sleep(200);
    const sidecar = (memo) => JSON.stringify({ id, url: "u", title: "T", savedAt: "2026-09-03T00:00:00+09:00", savedOn: "other", memo, tags: [], updatedAt: "" });
    // Several rounds of rapid, sub-debounce-interval writes: whatever timing
    // relationship the fs events and readItem calls end up in, the store must
    // always settle on the content of the very last write, never a stale one.
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 15; i++) {
        await writeFile(join(dir, `${id}.json`), sidecar(`round${round}-memo${i}`));
      }
      await waitFor(() => store.get(id)?.memo === `round${round}-memo14`, 8000);
      assert.equal(store.get(id).memo, `round${round}-memo14`);
    }
  } finally {
    await watcher.close();
  }
});

test("close resolves before a write for a file dropped just prior is ever made", async () => {
  const archiveDir = await mkdtemp(join(tmpdir(), "wa-"));
  const dir = join(archiveDir, "items", "2026", "09");
  await mkdir(dir, { recursive: true });
  const store = new Store(":memory:");
  const id = "01J7ZK4M3N5P6Q7R8S9T0V1W4Z";
  const debounceMs = 50;
  const watcher = startWatcher({ archiveDir, machineName: "m", store, debounceMs });
  try {
    await sleep(200);
    const sidecar = JSON.stringify({ id, url: "u", title: "T", savedAt: "2026-09-03T00:00:00+09:00", savedOn: "other", memo: "m", tags: [], updatedAt: "" });
    await writeFile(join(dir, `${id}.json`), sidecar);
    await watcher.close();
    await sleep(debounceMs * 4);
    assert.equal(store.get(id), null);
  } finally {
    // close() must be safe to call again (callers may not track whether it
    // already ran); it should stay a harmless no-op.
    await watcher.close();
  }
});

test("close awaits in-flight work so no store access happens after it resolves", async () => {
  const archiveDir = await mkdtemp(join(tmpdir(), "wa-"));
  const dir = join(archiveDir, "items", "2026", "09");
  await mkdir(dir, { recursive: true });
  const real = new Store(":memory:");
  let resolvedClose = false;
  const guarded = new Proxy(real, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") {
        return value;
      }
      return (...args) => {
        if (resolvedClose && (prop === "upsert" || prop === "remove")) {
          throw new Error(`store.${String(prop)} called after watcher.close() resolved`);
        }
        return value.apply(target, args);
      };
    }
  });
  const errors = [];
  const id = "01J7ZK4M3N5P6Q7R8S9T0V1W5A";
  const debounceMs = 30;
  const watcher = startWatcher({ archiveDir, machineName: "m", store: guarded, debounceMs, onError: (e) => errors.push(e) });
  try {
    await sleep(200);
    const sidecar = (memo) => JSON.stringify({ id, url: "u", title: "T", savedAt: "2026-09-03T00:00:00+09:00", savedOn: "other", memo, tags: [], updatedAt: "" });
    // Fire off a burst of writes and close immediately: some work may still
    // be in flight, but none of it may reach the store after close() returns.
    for (let i = 0; i < 10; i++) {
      await writeFile(join(dir, `${id}.json`), sidecar(`m${i}`));
    }
    await watcher.close();
    resolvedClose = true;
    await sleep(debounceMs * 8);
    assert.deepEqual(errors, []);
  } finally {
    real.close();
  }
});
