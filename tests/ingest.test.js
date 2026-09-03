import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingest } from "../src/ingest.js";
import { Store } from "../src/store.js";
import { ULID_RE } from "../src/sidecar.js";

const HTML = "<html><!--\n Page saved with SingleFile \n url: https://header.example/ \n saved date: Wed Sep 03 2026 10:12:00 GMT+0900\n--><head><title>From title</title></head></html>";

test("ingest writes html and sidecar under YYYY/MM and indexes the item", async () => {
  const archiveDir = await mkdtemp(join(tmpdir(), "wa-"));
  const store = new Store(":memory:");
  const now = new Date(2026, 8, 3, 10, 12, 0);
  const item = await ingest({ archiveDir, machineName: "mac", store }, { html: Buffer.from(HTML), url: "https://form.example/p", filename: "page.html", now });
  assert.ok(ULID_RE.test(item.id));
  assert.equal(item.relDir, "items/2026/09");
  assert.equal(item.url, "https://form.example/p");
  assert.equal(item.title, "From title");
  assert.equal(item.savedOn, "mac");
  assert.equal(item.status, "ok");
  assert.deepEqual((await readdir(join(archiveDir, "items", "2026", "09"))).sort(), [`${item.id}.html`, `${item.id}.json`]);
  assert.equal(await readFile(join(archiveDir, item.relDir, `${item.id}.html`), "utf8"), HTML, "html stored unmodified");
  assert.equal(store.get(item.id).title, "From title");
});

test("ingest falls back to the filename for the title and the header url", async () => {
  const archiveDir = await mkdtemp(join(tmpdir(), "wa-"));
  const store = new Store(":memory:");
  const item = await ingest({ archiveDir, machineName: "mac", store }, { html: "<html><!--\n Page saved with SingleFile \n url: https://header.example/ \n--></html>", url: "", filename: "My Page (2026-09-03).html" });
  assert.equal(item.title, "My Page (2026-09-03)");
  assert.equal(item.url, "https://header.example/");
});

test("ingest rethrows and leaves no partial files when the target directory can't be created", async () => {
  const archiveDir = await mkdtemp(join(tmpdir(), "wa-"));
  const store = new Store(":memory:");
  const now = new Date(2026, 8, 3, 10, 12, 0);
  await mkdir(join(archiveDir, "items", "2026"), { recursive: true });
  // Put a plain file where the month directory needs to be created, so
  // mkdir(dir, { recursive: true }) fails with ENOTDIR and the write never
  // happens at all -- exercising the same "leave nothing behind" guarantee
  // as a failure partway through the writes.
  await writeFile(join(archiveDir, "items", "2026", "09"), "not a directory");
  await assert.rejects(() => ingest({ archiveDir, machineName: "mac", store }, { html: Buffer.from(HTML), url: "https://form.example/p", filename: "page.html", now }));
  assert.deepEqual(await readdir(join(archiveDir, "items", "2026")), ["09"]);
  assert.equal(store.list().total, 0);
});
