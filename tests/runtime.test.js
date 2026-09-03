import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createRuntime } from "../src/runtime.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";

const A = "01J7ZK4M3N5P6Q7R8S9T0V1W2A";
const B = "01J7ZK4M3N5P6Q7R8S9T0V1W2B";

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

async function archiveWith(id) {
  const archiveDir = await mkdtemp(join(tmpdir(), "wa-arc-"));
  const dir = join(archiveDir, "items", "2026", "09");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.html`), "<html></html>");
  await writeFile(join(dir, `${id}.json`), JSON.stringify({ id, url: "u", title: "T", savedAt: "2026-09-01T00:00:00+09:00", savedOn: "m", memo: "", tags: [], updatedAt: "" }));
  return archiveDir;
}

async function setup({ env = {}, file } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "wa-cfg-"));
  const configFile = join(dir, "config.json");
  if (file) {
    await writeFile(configFile, JSON.stringify(file));
  }
  const config = loadConfig({ env: { DATA_DIR: dir, ...env }, configFile });
  const store = new Store(":memory:");
  const runtime = createRuntime({ config, store, watcherOptions: { debounceMs: 50 } });
  return { runtime, store, config, configFile };
}

test("start on an unconfigured runtime indexes nothing and does not fail", async () => {
  const { runtime, store } = await setup();
  await runtime.start();
  try {
    assert.equal(runtime.config.configured, false);
    assert.equal(store.list({}).total, 0);
  } finally {
    await runtime.close();
  }
});

test("start on a configured runtime indexes the archive and watches it", async () => {
  const archiveDir = await archiveWith(A);
  const { runtime, store } = await setup({ file: { archiveDir } });
  await runtime.start();
  try {
    assert.ok(store.get(A));
    await sleep(200);
    await writeFile(join(archiveDir, "items", "2026", "09", `${B}.html`), "<html></html>");
    await waitFor(() => store.get(B));
  } finally {
    await runtime.close();
  }
});

test("apply on an unconfigured runtime writes the config and brings the archive up", async () => {
  const archiveDir = await archiveWith(A);
  const { runtime, store, configFile } = await setup();
  await runtime.start();
  try {
    const result = await runtime.apply({ archiveDir, machineName: "box", openAfterSave: false });
    assert.equal(result.restartRequired, false);
    assert.equal(runtime.config.configured, true);
    assert.equal(runtime.config.archiveDir, archiveDir);
    assert.equal(runtime.config.machineName, "box");
    assert.equal(runtime.config.openAfterSave, false);
    assert.deepEqual(runtime.config.sources.archiveDir, "file");
    assert.deepEqual(JSON.parse(await readFile(configFile, "utf8")), { archiveDir, machineName: "box", openAfterSave: false });
    assert.ok(store.get(A));
    await sleep(200);
    await writeFile(join(archiveDir, "items", "2026", "09", `${B}.html`), "<html></html>");
    await waitFor(() => store.get(B));
  } finally {
    await runtime.close();
  }
});

test("apply with a new archiveDir replaces the index and moves the watcher", async () => {
  const oldDir = await archiveWith(A);
  const newDir = await archiveWith(B);
  const { runtime, store } = await setup({ file: { archiveDir: oldDir } });
  await runtime.start();
  try {
    assert.ok(store.get(A));
    await runtime.apply({ archiveDir: newDir });
    assert.equal(store.get(A), null);
    assert.ok(store.get(B));
    await sleep(200);
    const C = "01J7ZK4M3N5P6Q7R8S9T0V1W2C";
    await writeFile(join(oldDir, "items", "2026", "09", `${C}.html`), "<html></html>");
    await writeFile(join(newDir, "items", "2026", "09", `${A}.html`), "<html></html>");
    await waitFor(() => store.get(A));
    assert.equal(store.get(C), null, "old archive is no longer watched");
  } finally {
    await runtime.close();
  }
});

test("apply with only openAfterSave changed does not rebuild the index", async () => {
  const archiveDir = await archiveWith(A);
  const { runtime, store } = await setup({ file: { archiveDir } });
  await runtime.start();
  try {
    store.upsert({ id: B, relDir: "items/x", hasHtml: false, status: "ok", tags: [], conflictFiles: [] });
    await runtime.apply({ openAfterSave: false });
    assert.ok(store.get(B), "index was not rebuilt");
    assert.equal(runtime.config.openAfterSave, false);
  } finally {
    await runtime.close();
  }
});

test("apply with a new port only persists it and reports a restart", async () => {
  const archiveDir = await archiveWith(A);
  const { runtime, configFile } = await setup({ file: { archiveDir } });
  await runtime.start();
  try {
    const result = await runtime.apply({ port: 9999 });
    assert.equal(result.restartRequired, true);
    assert.equal(runtime.config.port, 8765, "listening port is unchanged until restart");
    assert.equal(JSON.parse(await readFile(configFile, "utf8")).port, 9999);
  } finally {
    await runtime.close();
  }
});

test("apply ignores keys that are overridden by environment variables", async () => {
  const archiveDir = await archiveWith(A);
  const { runtime, configFile } = await setup({ env: { MACHINE_NAME: "envbox" }, file: { archiveDir } });
  await runtime.start();
  try {
    await runtime.apply({ machineName: "other" });
    assert.equal(runtime.config.machineName, "envbox");
    assert.equal(JSON.parse(await readFile(configFile, "utf8")).machineName, undefined);
  } finally {
    await runtime.close();
  }
});
