import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanArchive, rebuildIndex } from "../src/scanner.js";
import { Store } from "../src/store.js";

const A = "01J7ZK4M3N5P6Q7R8S9T0V1W2A";
const B = "01J7ZK4M3N5P6Q7R8S9T0V1W2B";

test("scanArchive lists unique ids per directory and rebuildIndex fills the store", async () => {
  const archiveDir = await mkdtemp(join(tmpdir(), "wa-"));
  await mkdir(join(archiveDir, "items", "2026", "08"), { recursive: true });
  await mkdir(join(archiveDir, "items", "2026", "09"), { recursive: true });
  const sidecar = (id) => JSON.stringify({ id, url: "u", title: "T " + id, savedAt: "2026-09-01T00:00:00+09:00", savedOn: "m", memo: "", tags: ["x"], updatedAt: "" });
  await writeFile(join(archiveDir, "items", "2026", "08", `${A}.html`), "<html></html>");
  await writeFile(join(archiveDir, "items", "2026", "08", `${A}.json`), sidecar(A));
  await writeFile(join(archiveDir, "items", "2026", "09", `${B}.json`), sidecar(B));
  await writeFile(join(archiveDir, "items", "2026", "09", "README.txt"), "ignore me");
  const found = await scanArchive(archiveDir);
  assert.deepEqual(found.sort((x, y) => x.id.localeCompare(y.id)), [
    { relDir: "items/2026/08", id: A }, { relDir: "items/2026/09", id: B }
  ]);
  const store = new Store(":memory:");
  store.upsert({ id: "01J7ZK4M3N5P6Q7R8S9T0V1W2Z", relDir: "items/x", hasHtml: false, status: "ok", tags: [], conflictFiles: [] });
  const count = await rebuildIndex({ archiveDir, machineName: "m", store });
  assert.equal(count, 2);
  assert.equal(store.get("01J7ZK4M3N5P6Q7R8S9T0V1W2Z"), null, "clear removed stale rows");
  assert.equal(store.get(B).status, "pending");
  assert.equal(store.get(A).status, "ok");
});

test("scanArchive tolerates a missing items directory", async () => {
  const archiveDir = await mkdtemp(join(tmpdir(), "wa-"));
  assert.deepEqual(await scanArchive(archiveDir), []);
});
