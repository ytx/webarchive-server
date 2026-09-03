import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ULID_RE, classifyFile, normalizeTags, parseHtmlMeta, readSidecar, writeSidecarAtomic, sidecarDefaults } from "../src/sidecar.js";

const ID = "01J7ZK4M3N5P6Q7R8S9T0V1W2X";

test("classifyFile recognizes html, json, conflict copies and temp files", () => {
  assert.deepEqual(classifyFile(`${ID}.html`), { kind: "html", id: ID });
  assert.deepEqual(classifyFile(`${ID}.json`), { kind: "json", id: ID });
  assert.deepEqual(classifyFile(`${ID} (競合コピー 2026-09-03).json`), { kind: "conflict", id: ID });
  assert.deepEqual(classifyFile(`${ID} (macbook's conflicted copy 2026-09-03).json`), { kind: "conflict", id: ID });
  assert.deepEqual(classifyFile(`.${ID}.json.tmp`), { kind: "tmp", id: ID });
  assert.deepEqual(classifyFile(`.${ID}.html.tmp-a1b2`), { kind: "tmp", id: ID });
  assert.deepEqual(classifyFile("notes.txt"), { kind: "other", id: null });
  assert.ok(ULID_RE.test(ID));
  assert.ok(!ULID_RE.test("abc"));
});

test("normalizeTags lower-cases, trims, drops empties and duplicates, keeps order", () => {
  assert.deepEqual(normalizeTags([" JavaScript ", "", "javascript", "Research", "研究 "]), ["javascript", "research", "研究"]);
  assert.deepEqual(normalizeTags(undefined), []);
});

test("parseHtmlMeta extracts title and SingleFile header", () => {
  const html = `<!DOCTYPE html> <html><!--
 Page saved with SingleFile
 url: https://example.com/a?b=1
 saved date: Wed Sep 03 2026 10:12:00 GMT+0900 (日本標準時)
--><head><title> 記事タイトル &amp; more </title></head><body></body></html>`;
  const meta = parseHtmlMeta(html);
  assert.equal(meta.title, "記事タイトル & more");
  assert.equal(meta.url, "https://example.com/a?b=1");
  assert.ok(meta.savedAt.startsWith("2026-09-03T"));
});

test("parseHtmlMeta returns nulls when nothing is found", () => {
  assert.deepEqual(parseHtmlMeta("<html></html>"), { title: null, url: null, savedAt: null });
});

test("writeSidecarAtomic writes via temp file and readSidecar reads it back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wa-"));
  const path = join(dir, `${ID}.json`);
  const data = sidecarDefaults({ id: ID, url: "https://example.com", title: "t", savedAt: "2026-09-03T10:12:00+09:00", savedOn: "mac" });
  await writeSidecarAtomic(path, data);
  assert.deepEqual(await readSidecar(path), { ...data, memo: "", tags: [] });
  assert.deepEqual(await readdir(dir), [`${ID}.json`]);
  const text = await readFile(path, "utf8");
  assert.ok(text.endsWith("\n"));
});

test("readSidecar throws on invalid JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wa-"));
  const path = join(dir, `${ID}.json`);
  await (await import("node:fs/promises")).writeFile(path, "{ broken");
  await assert.rejects(() => readSidecar(path), SyntaxError);
});
