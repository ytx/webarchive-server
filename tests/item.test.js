import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readItem, SIDECAR_GENERATION_MIN_AGE_MS } from "../src/item.js";

const ID = "01J7ZK4M3N5P6Q7R8S9T0V1W2X";
const HTML = `<html><!--\n Page saved with SingleFile \n url: https://example.com/p \n saved date: Wed Sep 03 2026 10:12:00 GMT+0900\n--><head><title>T</title></head></html>`;

async function setup() {
  const archiveDir = await mkdtemp(join(tmpdir(), "wa-"));
  const dir = join(archiveDir, "items", "2026", "09");
  await mkdir(dir, { recursive: true });
  return { archiveDir, dir, ctx: { archiveDir, machineName: "mac" } };
}

test("ok item with html and json", async () => {
  const { dir, ctx } = await setup();
  await writeFile(join(dir, `${ID}.html`), HTML);
  await writeFile(join(dir, `${ID}.json`), JSON.stringify({ id: ID, url: "https://example.com/p", title: "T", savedAt: "2026-09-03T10:12:00+09:00", savedOn: "mac", memo: "m", tags: ["A", "a"], updatedAt: "2026-09-03T10:12:00+09:00" }));
  const item = await readItem(ctx, "items/2026/09", ID);
  assert.equal(item.status, "ok");
  assert.equal(item.hasHtml, true);
  assert.deepEqual(item.tags, ["a"]);
  assert.equal(item.memo, "m");
  assert.equal(item.relDir, "items/2026/09");
});

test("json without html is pending", async () => {
  const { dir, ctx } = await setup();
  await writeFile(join(dir, `${ID}.json`), JSON.stringify({ id: ID, url: "u", title: "T", savedAt: "x", savedOn: "mac", memo: "", tags: [], updatedAt: "x" }));
  assert.equal((await readItem(ctx, "items/2026/09", ID)).status, "pending");
});

test("unparsable json is broken", async () => {
  const { dir, ctx } = await setup();
  await writeFile(join(dir, `${ID}.html`), HTML);
  await writeFile(join(dir, `${ID}.json`), "{ nope");
  const item = await readItem(ctx, "items/2026/09", ID);
  assert.equal(item.status, "broken");
  assert.equal(item.hasHtml, true);
  assert.equal(item.title, null);
});

test("html only from the default path is pending and leaves the directory unchanged", async () => {
  const { dir, ctx } = await setup();
  await writeFile(join(dir, `${ID}.html`), HTML);
  const item = await readItem(ctx, "items/2026/09", ID);
  assert.equal(item.status, "pending");
  assert.equal(item.hasHtml, true);
  assert.equal(item.url, "https://example.com/p");
  assert.equal(item.title, "T");
  assert.equal(item.savedOn, null);
  assert.equal(item.memo, "");
  assert.deepEqual(item.tags, []);
  assert.equal(item.updatedAt, null);
  assert.deepEqual(await readdir(dir), [`${ID}.html`]);
});

test("html only with createSidecar and an old mtime generates the sidecar", async () => {
  const { dir, ctx } = await setup();
  const htmlPath = join(dir, `${ID}.html`);
  await writeFile(htmlPath, HTML);
  const old = new Date(Date.now() - SIDECAR_GENERATION_MIN_AGE_MS - 1000);
  await utimes(htmlPath, old, old);
  const item = await readItem(ctx, "items/2026/09", ID, { createSidecar: true });
  assert.equal(item.status, "ok");
  assert.equal(item.url, "https://example.com/p");
  assert.equal(item.title, "T");
  assert.equal(item.savedOn, "mac");
  const written = JSON.parse(await readFile(join(dir, `${ID}.json`), "utf8"));
  assert.equal(written.id, ID);
});

test("html only with createSidecar and a fresh mtime is pending, no write", async () => {
  const { dir, ctx } = await setup();
  await writeFile(join(dir, `${ID}.html`), HTML);
  const item = await readItem(ctx, "items/2026/09", ID, { createSidecar: true });
  assert.equal(item.status, "pending");
  assert.deepEqual(await readdir(dir), [`${ID}.html`]);
});

test("conflict copies mark the item conflict", async () => {
  const { dir, ctx } = await setup();
  await writeFile(join(dir, `${ID}.html`), HTML);
  await writeFile(join(dir, `${ID}.json`), JSON.stringify({ id: ID, url: "u", title: "T", savedAt: "x", savedOn: "mac", memo: "", tags: [], updatedAt: "x" }));
  await writeFile(join(dir, `${ID} (競合コピー).json`), "{}");
  const item = await readItem(ctx, "items/2026/09", ID);
  assert.equal(item.status, "conflict");
  assert.deepEqual(item.conflictFiles, [`${ID} (競合コピー).json`]);
});

test("nothing on disk returns null", async () => {
  const { ctx } = await setup();
  assert.equal(await readItem(ctx, "items/2026/09", ID), null);
});
