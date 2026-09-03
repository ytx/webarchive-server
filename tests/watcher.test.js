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
