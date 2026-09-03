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

test("close leaves the store untouched when nothing had settled enough to be scheduled yet", async () => {
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
    // close() is called immediately, before chokidar's awaitWriteFinish window
    // (~debounceMs) has even elapsed, so nothing has been scheduled yet: this
    // proves shutdown is prompt and doesn't leave a stray timer that later
    // writes to the store, not that in-flight work gets dropped (see the
    // deterministic in-flight test below for that).
    await watcher.close();
    await sleep(debounceMs * 4);
    assert.equal(store.get(id), null);
  } finally {
    // close() must be safe to call again (callers may not track whether it
    // already ran); it should stay a harmless no-op.
    await watcher.close();
  }
});

test("close awaits a genuinely in-flight read, applies its result, then resolves; nothing touches the store afterward", async () => {
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

  const id = "01J7ZK4M3N5P6Q7R8S9T0V1W5A";
  const relDir = "items/2026/09";
  const resolvedItem = {
    id, relDir, hasHtml: true, conflictFiles: [], url: "u", title: "T",
    memo: "in-flight-result", tags: [], savedAt: "2026-09-03T00:00:00+09:00", savedOn: "other", updatedAt: "", status: "ok"
  };
  let readItemCalls = 0;
  let releaseRead;
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  // Deterministic stand-in for the real readItem: it only resolves once the
  // test releases it, so we can prove a read is genuinely in flight (not
  // just assume it, as the earlier vacuous tests did) when close() is called.
  const injectedReadItem = async () => {
    readItemCalls++;
    await readGate;
    return resolvedItem;
  };

  const debounceMs = 20;
  const watcher = startWatcher({ archiveDir, machineName: "m", store: guarded, debounceMs, readItem: injectedReadItem });
  try {
    await sleep(200);
    await writeFile(join(dir, `${id}.json`), "{}");
    await waitFor(() => readItemCalls > 0);
    // A second event for the same key while the read is still gated: this
    // must be coalesced into a dropped "dirty" re-run once close() is
    // called, not a second readItem call.
    await writeFile(join(dir, `${id}.json`), "{}");
    await sleep(debounceMs * 3);

    let closeResolved = false;
    const closePromise = watcher.close().then(() => {
      closeResolved = true;
    });
    await sleep(debounceMs * 3);
    assert.equal(closeResolved, false, "close() must not resolve while a read is still in flight");
    assert.equal(real.get(id), null, "the store must not be written until the in-flight read completes");

    releaseRead();
    await closePromise;
    resolvedClose = true;

    assert.equal(closeResolved, true, "close() must resolve once the in-flight read finishes");
    assert.equal(real.get(id)?.memo, "in-flight-result", "the in-flight read's result must be applied before close() resolves");

    await sleep(debounceMs * 4);
    assert.equal(readItemCalls, 1, "a dirty re-run queued while closing must be dropped, not executed as a second read");
  } finally {
    real.close();
  }
});
