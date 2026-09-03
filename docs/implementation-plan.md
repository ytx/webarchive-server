# Local Archive Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Node.js server that receives SingleFile captures, stores them as HTML + JSON sidecar in a Dropbox-synced folder, indexes them in a local SQLite, and serves a web UI for listing, searching and editing memo/tags; plus a minimal SingleFile option that opens the server's edit page after upload.

**Architecture:** Source of truth is plain files under `<ARCHIVE_DIR>/items/YYYY/MM/<ULID>.{html,json}`. Each machine runs the server, rebuilds a local SQLite (FTS5 trigram) index at startup and keeps it current with a chokidar watcher. The HTTP API (Hono) writes sidecars atomically and updates the index directly; Dropbox-delivered changes from other machines arrive via the watcher. The web UI is static HTML/JS served by the same process.

**Tech Stack:** Node.js 22+ (developed on 24.7), ES modules, `node:sqlite`, `node:test`, Hono 4 + `@hono/node-server` 2, chokidar 5, ulid 3.

**Spec:** `docs/design.md` (in the SingleFile fork repo). Mockup: https://claude.ai/code/artifact/b02d74a0-07c9-445e-a575-9abba256819c (direction A).

## Global Constraints

- Server lives in a **separate repository**: `~/git/webarchive-server`. Tasks 1–8 run there. Task 9 runs in `~/git/SingleFile`.
- Bind to `127.0.0.1` only. No authentication. Default port `8765`.
- Item id is a ULID (26 chars, Crockford base32). File names are exactly `<ULID>.html` and `<ULID>.json`.
- Sidecar fields: `id, url, title, savedAt, savedOn, memo, tags, updatedAt` (ISO 8601 with offset). Tags are lower-cased, trimmed, de-duplicated, non-empty.
- Sidecar writes are atomic: write `.<ULID>.json.tmp` in the same directory, then `rename`.
- Status values: `ok | conflict | broken | pending`.
- Conflict copy = file in the same directory whose name starts with `<ULID>` and ends with `.json` but is not exactly `<ULID>.json`.
- Saved HTML is served with header `Content-Security-Policy: sandbox`.
- FTS uses `tokenize = 'trigram'`; queries shorter than 3 characters fall back to `LIKE`.
- Received HTML is stored unmodified.
- Tests: `node --test tests/` must pass before every commit. Every test uses a fresh temp dir from `fs.mkdtemp`.
- SingleFile changes must stay minimal (upstream tracking): one option, one new i18n key (en + ja), no refactoring of surrounding code.

---

## File structure (server repo `~/git/webarchive-server`)

```
package.json            type=module, scripts: start, test
src/config.js           loadConfig(): env + optional config.json → { archiveDir, dataDir, port, machineName }
src/sidecar.js          pure helpers: ULID regex, classifyFile, normalizeTags, parseHtmlMeta, readSidecar, writeSidecarAtomic
src/item.js             readItem(archiveDir, relDir, id) → item with status (reads the directory, creates a sidecar for html-only items)
src/store.js            Store: SQLite schema, upsert/remove/get/list/tags/rebuildFrom
src/scanner.js          scanArchive(archiveDir) → [{ relDir, id }] for rebuild
src/watcher.js          startWatcher({ archiveDir, store }) chokidar → debounced readItem → store
src/ingest.js           ingest({ archiveDir, machineName, store }, { html, url, filename }) → item
src/app.js              createApp({ config, store }) → Hono app (API + static UI + page serving)
src/server.js           entry: loadConfig, open Store, rebuild, watcher, listen
public/index.html       list screen
public/item.html        item screen
public/app.css          shared styles (direction A tokens)
public/list.js          list screen logic
public/item.js          item screen logic (memo/tags editing, tag autocomplete, conflict, repair)
tests/*.test.js         one file per module
README.md               run instructions + SingleFile settings table
```

---

### Task 1: Project scaffold and config

**Files:**
- Create: `package.json`, `.gitignore`, `src/config.js`, `tests/config.test.js`

**Interfaces:**
- Produces: `loadConfig({ env = process.env, configFile } = {}) → { archiveDir, dataDir, port, machineName }`. Throws `Error("ARCHIVE_DIR is required")` when unset.

- [ ] **Step 1: Create the repo and package.json**

```bash
mkdir -p ~/git/webarchive-server && cd ~/git/webarchive-server && git init
```

`package.json`:

```json
{
  "name": "webarchive-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.13" },
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test tests/"
  },
  "dependencies": {
    "@hono/node-server": "^2.1.1",
    "chokidar": "^5.0.0",
    "hono": "^4.13.5",
    "ulid": "^3.0.2"
  }
}
```

`.gitignore`:

```
node_modules/
config.json
*.sqlite
```

Run: `npm install`

- [ ] **Step 2: Write the failing test**

`tests/config.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

test("loadConfig reads env with defaults", () => {
  const config = loadConfig({ env: { ARCHIVE_DIR: "/tmp/a" } });
  assert.equal(config.archiveDir, "/tmp/a");
  assert.equal(config.port, 8765);
  assert.ok(config.dataDir.endsWith("webarchive"));
  assert.ok(config.machineName.length > 0);
});

test("loadConfig throws without ARCHIVE_DIR", () => {
  assert.throws(() => loadConfig({ env: {} }), /ARCHIVE_DIR is required/);
});

test("config file values are overridden by env", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wa-"));
  const file = join(dir, "config.json");
  await writeFile(file, JSON.stringify({ archiveDir: "/from/file", port: 9000, machineName: "filebox" }));
  const config = loadConfig({ env: { PORT: "9100" }, configFile: file });
  assert.equal(config.archiveDir, "/from/file");
  assert.equal(config.port, 9100);
  assert.equal(config.machineName, "filebox");
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL, cannot find module `../src/config.js`

- [ ] **Step 4: Implement**

`src/config.js`:

```js
import { readFileSync, existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

export function loadConfig({ env = process.env, configFile = env.WEBARCHIVE_CONFIG ?? "config.json" } = {}) {
  const fromFile = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {};
  const archiveDir = env.ARCHIVE_DIR ?? fromFile.archiveDir;
  if (!archiveDir) {
    throw new Error("ARCHIVE_DIR is required (env ARCHIVE_DIR or config.json archiveDir)");
  }
  return {
    archiveDir: resolve(archiveDir),
    dataDir: resolve(env.DATA_DIR ?? fromFile.dataDir ?? join(homedir(), ".local", "share", "webarchive")),
    port: Number(env.PORT ?? fromFile.port ?? 8765),
    machineName: env.MACHINE_NAME ?? fromFile.machineName ?? hostname()
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: 3 passing

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .gitignore src/config.js tests/config.test.js
git commit -m "scaffold the project and load configuration"
```

---

### Task 2: Sidecar helpers

**Files:**
- Create: `src/sidecar.js`, `tests/sidecar.test.js`

**Interfaces:**
- Produces:
  - `ULID_RE` (RegExp, whole string, 26 Crockford base32 chars)
  - `classifyFile(name) → { kind: "html"|"json"|"conflict"|"tmp"|"other", id: string|null }`
  - `normalizeTags(tags) → string[]`
  - `parseHtmlMeta(html) → { title: string|null, url: string|null, savedAt: string|null }`
  - `async readSidecar(path) → object` (throws SyntaxError on bad JSON)
  - `async writeSidecarAtomic(path, data)`
  - `sidecarDefaults({ id, url, title, savedAt, savedOn }) → full sidecar object with memo "" and tags []`

- [ ] **Step 1: Write the failing test**

`tests/sidecar.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL, cannot find module `../src/sidecar.js`

- [ ] **Step 3: Implement**

`src/sidecar.js`:

```js
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ULID_PREFIX_RE = /^[0-9A-HJKMNP-TV-Z]{26}/;

export function classifyFile(name) {
  const tmp = /^\.([0-9A-HJKMNP-TV-Z]{26})\.json\.tmp/.exec(name);
  if (tmp) {
    return { kind: "tmp", id: tmp[1] };
  }
  const id = ULID_PREFIX_RE.exec(name)?.[0];
  if (!id) {
    return { kind: "other", id: null };
  }
  if (name === `${id}.html`) {
    return { kind: "html", id };
  }
  if (name === `${id}.json`) {
    return { kind: "json", id };
  }
  if (name.endsWith(".json")) {
    return { kind: "conflict", id };
  }
  return { kind: "other", id: null };
}

export function normalizeTags(tags) {
  const seen = new Set();
  const result = [];
  for (const raw of Array.isArray(tags) ? tags : []) {
    const tag = String(raw).trim().toLowerCase();
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      result.push(tag);
    }
  }
  return result;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", "#39": "'" };

function decodeEntities(text) {
  return text.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return ENTITIES[entity] ?? match;
  });
}

export function parseHtmlMeta(html) {
  const head = html.slice(0, 64 * 1024);
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim() || null : null;
  const comment = /<!--\s*Page saved with SingleFile([\s\S]*?)-->/i.exec(head);
  let url = null;
  let savedAt = null;
  if (comment) {
    url = /^\s*url:\s*(\S+)/m.exec(comment[1])?.[1] ?? null;
    const dateText = /^\s*saved date:\s*(.+?)\s*$/m.exec(comment[1])?.[1];
    if (dateText) {
      const date = new Date(dateText);
      savedAt = Number.isNaN(date.getTime()) ? null : toIsoWithOffset(date);
    }
  }
  return { title, url, savedAt };
}

export function toIsoWithOffset(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const pad = (n) => String(Math.trunc(Math.abs(n))).padStart(2, "0");
  const local = new Date(date.getTime() + offsetMinutes * 60000);
  return local.toISOString().replace(/\.\d{3}Z$/, "") + sign + pad(offsetMinutes / 60) + ":" + pad(offsetMinutes % 60);
}

export function sidecarDefaults({ id, url, title, savedAt, savedOn }) {
  return {
    id,
    url: url ?? null,
    title: title ?? null,
    savedAt: savedAt ?? toIsoWithOffset(),
    savedOn: savedOn ?? null,
    memo: "",
    tags: [],
    updatedAt: savedAt ?? toIsoWithOffset()
  };
}

export async function readSidecar(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writeSidecarAtomic(path, data) {
  const id = data.id;
  const tmp = join(dirname(path), `.${id}.json.tmp-${randomBytes(4).toString("hex")}`);
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: all passing

- [ ] **Step 5: Commit**

```bash
git add src/sidecar.js tests/sidecar.test.js
git commit -m "add sidecar helpers: file classification, tags, html meta, atomic writes"
```

---

### Task 3: SQLite store

**Files:**
- Create: `src/store.js`, `tests/store.test.js`

**Interfaces:**
- Produces: `class Store`
  - `constructor(dbPath)` (`":memory:"` allowed)
  - `upsert(item)` where `item = { id, url, title, memo, savedAt, savedOn, updatedAt, relDir, hasHtml, status, tags: string[], conflictFiles: string[] }`
  - `remove(id)`
  - `get(id) → item | null`
  - `list({ q = "", tag = "", status = "", page = 1, limit = 50 }) → { items, total, page, limit }` (newest `savedAt` first)
  - `tags() → [{ tag, count }]` sorted by count desc then tag
  - `clear()`, `close()`

- [ ] **Step 1: Write the failing test**

`tests/store.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";

function item(overrides) {
  return {
    id: "01J7ZK4M3N5P6Q7R8S9T0V1W2X", url: "https://example.com/a", title: "SQLite FTS5 trigram の仕様",
    memo: "3文字未満は一致しない", savedAt: "2026-09-02T09:00:00+09:00", savedOn: "mac",
    updatedAt: "2026-09-02T09:00:00+09:00", relDir: "items/2026/09", hasHtml: true, status: "ok",
    tags: ["reference", "sqlite"], conflictFiles: [], ...overrides
  };
}

test("upsert then get round-trips an item", () => {
  const store = new Store(":memory:");
  store.upsert(item());
  assert.deepEqual(store.get("01J7ZK4M3N5P6Q7R8S9T0V1W2X"), item());
  assert.equal(store.get("nope"), null);
});

test("upsert replaces tags and remove deletes", () => {
  const store = new Store(":memory:");
  store.upsert(item());
  store.upsert(item({ tags: ["later"] }));
  assert.deepEqual(store.get(item().id).tags, ["later"]);
  store.remove(item().id);
  assert.equal(store.get(item().id), null);
  assert.deepEqual(store.tags(), []);
});

test("list orders newest first, paginates and filters by tag and status", () => {
  const store = new Store(":memory:");
  store.upsert(item({ id: "01J7ZK4M3N5P6Q7R8S9T0V1W2A", savedAt: "2026-09-01T00:00:00+09:00", tags: ["a"] }));
  store.upsert(item({ id: "01J7ZK4M3N5P6Q7R8S9T0V1W2B", savedAt: "2026-09-03T00:00:00+09:00", tags: ["b"], status: "conflict" }));
  store.upsert(item({ id: "01J7ZK4M3N5P6Q7R8S9T0V1W2C", savedAt: "2026-09-02T00:00:00+09:00", tags: [] }));
  const all = store.list({});
  assert.deepEqual(all.items.map((i) => i.id.slice(-1)), ["B", "C", "A"]);
  assert.equal(all.total, 3);
  assert.deepEqual(store.list({ page: 2, limit: 2 }).items.map((i) => i.id.slice(-1)), ["A"]);
  assert.deepEqual(store.list({ tag: "a" }).items.map((i) => i.id.slice(-1)), ["A"]);
  assert.deepEqual(store.list({ status: "conflict" }).items.map((i) => i.id.slice(-1)), ["B"]);
  assert.deepEqual(store.list({ tag: "-" }).items.map((i) => i.id.slice(-1)), ["C"]);
});

test("list searches title, url, memo and tags with Japanese partial match", () => {
  const store = new Store(":memory:");
  store.upsert(item());
  store.upsert(item({ id: "01J7ZK4M3N5P6Q7R8S9T0V1W2Y", title: "鶏むね肉の低温調理", memo: "", url: "https://cookpad.com/x", tags: ["recipe"] }));
  assert.equal(store.list({ q: "文字未満" }).items.length, 1);
  assert.equal(store.list({ q: "trigram" }).items.length, 1);
  assert.equal(store.list({ q: "cookpad" }).items.length, 1);
  assert.equal(store.list({ q: "recipe" }).items.length, 1);
  assert.equal(store.list({ q: "鶏" }).items.length, 1, "short query falls back to LIKE");
  assert.equal(store.list({ q: "\"quoted\" OR x" }).items.length, 0, "FTS syntax is escaped");
});

test("tags aggregates counts", () => {
  const store = new Store(":memory:");
  store.upsert(item());
  store.upsert(item({ id: "01J7ZK4M3N5P6Q7R8S9T0V1W2Y", tags: ["sqlite"] }));
  assert.deepEqual(store.tags(), [{ tag: "sqlite", count: 2 }, { tag: "reference", count: 1 }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL, cannot find module `../src/store.js`

- [ ] **Step 3: Implement**

`src/store.js`:

```js
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, url TEXT, title TEXT, memo TEXT NOT NULL DEFAULT '',
  saved_at TEXT, saved_on TEXT, updated_at TEXT,
  rel_dir TEXT NOT NULL, has_html INTEGER NOT NULL, status TEXT NOT NULL,
  conflict_files TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS items_saved_at ON items(saved_at DESC);
CREATE TABLE IF NOT EXISTS item_tags (item_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (item_id, tag));
CREATE INDEX IF NOT EXISTS item_tags_tag ON item_tags(tag);
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(id UNINDEXED, title, url, memo, tags, tokenize = 'trigram');
`;

export class Store {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  upsert(item) {
    const tags = item.tags ?? [];
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`INSERT INTO items (id, url, title, memo, saved_at, saved_on, updated_at, rel_dir, has_html, status, conflict_files)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET url = excluded.url, title = excluded.title, memo = excluded.memo, saved_at = excluded.saved_at,
          saved_on = excluded.saved_on, updated_at = excluded.updated_at, rel_dir = excluded.rel_dir, has_html = excluded.has_html,
          status = excluded.status, conflict_files = excluded.conflict_files`)
        .run(item.id, item.url ?? null, item.title ?? null, item.memo ?? "", item.savedAt ?? null, item.savedOn ?? null,
          item.updatedAt ?? null, item.relDir, item.hasHtml ? 1 : 0, item.status, JSON.stringify(item.conflictFiles ?? []));
      this.db.prepare("DELETE FROM item_tags WHERE item_id = ?").run(item.id);
      const insertTag = this.db.prepare("INSERT INTO item_tags (item_id, tag) VALUES (?, ?)");
      for (const tag of tags) {
        insertTag.run(item.id, tag);
      }
      this.db.prepare("DELETE FROM items_fts WHERE id = ?").run(item.id);
      this.db.prepare("INSERT INTO items_fts (id, title, url, memo, tags) VALUES (?, ?, ?, ?, ?)")
        .run(item.id, item.title ?? "", item.url ?? "", item.memo ?? "", tags.join(" "));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  remove(id) {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM items WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM item_tags WHERE item_id = ?").run(id);
      this.db.prepare("DELETE FROM items_fts WHERE id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  get(id) {
    const row = this.db.prepare("SELECT * FROM items WHERE id = ?").get(id);
    return row ? this.#hydrate(row) : null;
  }

  list({ q = "", tag = "", status = "", page = 1, limit = 50 } = {}) {
    const where = [];
    const params = [];
    if (q) {
      if ([...q].length >= 3) {
        where.push("items.id IN (SELECT id FROM items_fts WHERE items_fts MATCH ?)");
        params.push("\"" + q.replace(/"/g, "\"\"") + "\"");
      } else {
        where.push("items.id IN (SELECT id FROM items_fts WHERE title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' OR memo LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')");
        const like = "%" + q.replace(/[%_\\]/g, "\\$&") + "%";
        params.push(like, like, like, like);
      }
    }
    if (tag === "-") {
      where.push("NOT EXISTS (SELECT 1 FROM item_tags WHERE item_tags.item_id = items.id)");
    } else if (tag) {
      where.push("EXISTS (SELECT 1 FROM item_tags WHERE item_tags.item_id = items.id AND item_tags.tag = ?)");
      params.push(tag);
    }
    if (status) {
      where.push("items.status = ?");
      params.push(status);
    }
    const clause = where.length ? " WHERE " + where.join(" AND ") : "";
    const total = this.db.prepare("SELECT COUNT(*) AS n FROM items" + clause).get(...params).n;
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    const safePage = Math.max(1, Number(page) || 1);
    const rows = this.db.prepare("SELECT * FROM items" + clause + " ORDER BY saved_at DESC, id DESC LIMIT ? OFFSET ?")
      .all(...params, safeLimit, (safePage - 1) * safeLimit);
    return { items: rows.map((row) => this.#hydrate(row)), total, page: safePage, limit: safeLimit };
  }

  tags() {
    return this.db.prepare("SELECT tag, COUNT(*) AS count FROM item_tags GROUP BY tag ORDER BY count DESC, tag ASC").all()
      .map((row) => ({ tag: row.tag, count: row.count }));
  }

  clear() {
    this.db.exec("DELETE FROM items; DELETE FROM item_tags; DELETE FROM items_fts;");
  }

  close() {
    this.db.close();
  }

  #hydrate(row) {
    const tags = this.db.prepare("SELECT tag FROM item_tags WHERE item_id = ? ORDER BY rowid").all(row.id).map((r) => r.tag);
    return {
      id: row.id, url: row.url, title: row.title, memo: row.memo, savedAt: row.saved_at, savedOn: row.saved_on,
      updatedAt: row.updated_at, relDir: row.rel_dir, hasHtml: row.has_html === 1, status: row.status,
      tags, conflictFiles: JSON.parse(row.conflict_files)
    };
  }
}
```

`node:sqlite` has no transaction helper, so BEGIN/COMMIT are explicit.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: all passing. The `ExperimentalWarning: SQLite` line on stderr is expected on Node 24 and harmless.

- [ ] **Step 5: Commit**

```bash
git add src/store.js tests/store.test.js
git commit -m "add the SQLite index store with FTS5 trigram search"
```

---

### Task 4: readItem and archive scanning

**Files:**
- Create: `src/item.js`, `src/scanner.js`, `tests/item.test.js`, `tests/scanner.test.js`

**Interfaces:**
- Consumes: `sidecar.js` helpers, `Store`.
- Produces:
  - `async readItem({ archiveDir, machineName }, relDir, id) → item | null` — `null` when neither html nor json (nor conflict copies) exist. Status rules: json unparsable → `broken`; json ok but no html → `pending`; html but no json → creates the sidecar from `parseHtmlMeta` (status `ok`); conflict copies present → `conflict`, `conflictFiles` lists their names. `broken` items still carry `id, relDir, hasHtml` with `title/url/memo` null/empty.
  - `async scanArchive(archiveDir) → [{ relDir, id }]` unique, from `items/**`.
  - `async rebuildIndex({ archiveDir, machineName, store })` — `store.clear()` then upsert every scanned item; returns count.

- [ ] **Step 1: Write the failing tests**

`tests/item.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readItem } from "../src/item.js";

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

test("html only creates a sidecar from the html header", async () => {
  const { dir, ctx } = await setup();
  await writeFile(join(dir, `${ID}.html`), HTML);
  const item = await readItem(ctx, "items/2026/09", ID);
  assert.equal(item.status, "ok");
  assert.equal(item.url, "https://example.com/p");
  assert.equal(item.title, "T");
  assert.equal(item.savedOn, "mac");
  const written = JSON.parse(await readFile(join(dir, `${ID}.json`), "utf8"));
  assert.equal(written.id, ID);
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
```

`tests/scanner.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL, cannot find module `../src/item.js` / `../src/scanner.js`

- [ ] **Step 3: Implement**

`src/item.js`:

```js
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { classifyFile, normalizeTags, parseHtmlMeta, readSidecar, writeSidecarAtomic, sidecarDefaults } from "./sidecar.js";

export async function readItem({ archiveDir, machineName }, relDir, id) {
  const dir = join(archiveDir, relDir);
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const files = names.map((name) => ({ name, ...classifyFile(name) })).filter((file) => file.id === id);
  const hasHtml = files.some((file) => file.kind === "html");
  const hasJson = files.some((file) => file.kind === "json");
  const conflictFiles = files.filter((file) => file.kind === "conflict").map((file) => file.name).sort();
  if (!hasHtml && !hasJson && conflictFiles.length === 0) {
    return null;
  }
  const jsonPath = join(dir, `${id}.json`);
  const base = { id, relDir, hasHtml, conflictFiles, url: null, title: null, memo: "", tags: [], savedAt: null, savedOn: null, updatedAt: null };
  let sidecar;
  if (hasJson) {
    try {
      sidecar = await readSidecar(jsonPath);
    } catch {
      return { ...base, status: "broken" };
    }
  } else if (hasHtml) {
    const meta = parseHtmlMeta(await readFile(join(dir, `${id}.html`), "utf8"));
    sidecar = sidecarDefaults({ id, url: meta.url, title: meta.title, savedAt: meta.savedAt, savedOn: machineName });
    await writeSidecarAtomic(jsonPath, sidecar);
  } else {
    return { ...base, status: "conflict" };
  }
  let status = "ok";
  if (conflictFiles.length > 0) {
    status = "conflict";
  } else if (!hasHtml) {
    status = "pending";
  }
  return {
    ...base,
    url: sidecar.url ?? null,
    title: sidecar.title ?? null,
    memo: typeof sidecar.memo === "string" ? sidecar.memo : "",
    tags: normalizeTags(sidecar.tags),
    savedAt: sidecar.savedAt ?? null,
    savedOn: sidecar.savedOn ?? null,
    updatedAt: sidecar.updatedAt ?? null,
    status
  };
}
```

`src/scanner.js`:

```js
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { classifyFile } from "./sidecar.js";
import { readItem } from "./item.js";

export async function scanArchive(archiveDir) {
  const root = join(archiveDir, "items");
  let entries;
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const seen = new Map();
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const { kind, id } = classifyFile(entry.name);
    if (kind === "other" || kind === "tmp") {
      continue;
    }
    const relDir = relative(archiveDir, entry.parentPath).split("\\").join("/");
    seen.set(`${relDir}/${id}`, { relDir, id });
  }
  return [...seen.values()];
}

export async function rebuildIndex({ archiveDir, machineName, store }) {
  const found = await scanArchive(archiveDir);
  store.clear();
  let count = 0;
  for (const { relDir, id } of found) {
    const item = await readItem({ archiveDir, machineName }, relDir, id);
    if (item) {
      store.upsert(item);
      count++;
    }
  }
  return count;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all passing

- [ ] **Step 5: Commit**

```bash
git add src/item.js src/scanner.js tests/item.test.js tests/scanner.test.js
git commit -m "read items from disk and rebuild the index from the archive folder"
```

---

### Task 5: Watcher

**Files:**
- Create: `src/watcher.js`, `tests/watcher.test.js`

**Interfaces:**
- Consumes: `readItem`, `Store`.
- Produces: `startWatcher({ archiveDir, machineName, store, debounceMs = 300 }) → { close(): Promise<void> }`. Any add/change/unlink under `items/` for a file whose `classifyFile` kind is `html|json|conflict` schedules a debounced `readItem`; result `null` → `store.remove(id)`, else `store.upsert(item)`.

- [ ] **Step 1: Write the failing test**

`tests/watcher.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL, cannot find module `../src/watcher.js`

- [ ] **Step 3: Implement**

`src/watcher.js`:

```js
import { watch } from "chokidar";
import { basename, dirname, join, relative } from "node:path";
import { classifyFile } from "./sidecar.js";
import { readItem } from "./item.js";

export function startWatcher({ archiveDir, machineName, store, debounceMs = 300, onError = (e) => console.error(e) }) {
  const root = join(archiveDir, "items");
  const timers = new Map();

  function schedule(path) {
    const { kind, id } = classifyFile(basename(path));
    if (kind === "other" || kind === "tmp") {
      return;
    }
    const relDir = relative(archiveDir, dirname(path)).split("\\").join("/");
    const key = `${relDir}/${id}`;
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(async () => {
      timers.delete(key);
      try {
        const item = await readItem({ archiveDir, machineName }, relDir, id);
        if (item) {
          store.upsert(item);
        } else {
          store.remove(id);
        }
      } catch (error) {
        onError(error);
      }
    }, debounceMs));
  }

  const watcher = watch(root, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: debounceMs, pollInterval: 50 } });
  watcher.on("add", schedule).on("change", schedule).on("unlink", schedule).on("error", onError);

  return {
    async close() {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
      await watcher.close();
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: all passing. If the test is flaky on this machine, raise `waitFor`'s timeout to 8000 before touching the implementation; the `awaitWriteFinish` delay adds to every step.

- [ ] **Step 5: Commit**

```bash
git add src/watcher.js tests/watcher.test.js
git commit -m "watch the archive folder and keep the index current"
```

---

### Task 6: Ingest

**Files:**
- Create: `src/ingest.js`, `tests/ingest.test.js`

**Interfaces:**
- Consumes: `sidecar.js`, `readItem`, `Store`, `ulid`.
- Produces: `async ingest({ archiveDir, machineName, store }, { html: Buffer|string, url, filename, now = new Date() }) → item`. Writes `items/YYYY/MM/<ULID>.html` (YYYY/MM from `now`, local time) then the sidecar, then `store.upsert(readItem(...))`. Title = `parseHtmlMeta(html).title`, else `filename` without extension, else `null`. `url` argument wins over the html header url. On any write failure, both files are removed and the error re-thrown.

- [ ] **Step 1: Write the failing test**

`tests/ingest.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL, cannot find module `../src/ingest.js`

- [ ] **Step 3: Implement**

`src/ingest.js`:

```js
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ulid } from "ulid";
import { parseHtmlMeta, sidecarDefaults, writeSidecarAtomic, toIsoWithOffset } from "./sidecar.js";
import { readItem } from "./item.js";

export async function ingest({ archiveDir, machineName, store }, { html, url, filename, now = new Date() }) {
  const id = ulid(now.getTime());
  const relDir = `items/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}`;
  const dir = join(archiveDir, relDir);
  await mkdir(dir, { recursive: true });
  const htmlPath = join(dir, `${id}.html`);
  const jsonPath = join(dir, `${id}.json`);
  const text = Buffer.isBuffer(html) ? html.toString("utf8") : String(html);
  const meta = parseHtmlMeta(text);
  const title = meta.title ?? (filename ? filename.replace(/\.[^.]+$/, "") : null);
  const sidecar = sidecarDefaults({ id, url: url || meta.url, title, savedAt: toIsoWithOffset(now), savedOn: machineName });
  try {
    await writeFile(htmlPath, html);
    await writeSidecarAtomic(jsonPath, sidecar);
  } catch (error) {
    await unlink(htmlPath).catch(() => {});
    await unlink(jsonPath).catch(() => {});
    throw error;
  }
  const item = await readItem({ archiveDir, machineName }, relDir, id);
  store.upsert(item);
  return item;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: all passing

- [ ] **Step 5: Commit**

```bash
git add src/ingest.js tests/ingest.test.js
git commit -m "ingest SingleFile uploads into the archive folder"
```

---

### Task 7: HTTP API and server entry

**Files:**
- Create: `src/app.js`, `src/server.js`, `tests/app.test.js`, `README.md`

**Interfaces:**
- Consumes: `ingest`, `readItem`, `Store`, `sidecar.js`.
- Produces: `createApp({ config, store }) → Hono app` with routes:
  - `POST /api/singlefile` multipart `file` (required), `url` (optional) → `201 { id, openUrl }`; `400 { error }` when `file` missing.
  - `GET /api/items?q&tag&status&page&limit` → `store.list(...)`.
  - `GET /api/items/:id` → item plus `conflicts: [{ file, memo, tags, updatedAt }]` (parsed conflict copies; unparsable ones have `memo: null`); `404` when unknown.
  - `PATCH /api/items/:id` JSON `{ memo?, tags?, url?, title? }` → updated item. Reads the sidecar from disk; when unparsable (broken), starts from `sidecarDefaults`. Sets `updatedAt`. Writes atomically, then `store.upsert(readItem)`.
  - `POST /api/items/:id/resolve` JSON `{ choose: "main" | "conflict:<file>" }` → item. Copies `memo/tags` from the chosen conflict copy into the main sidecar when chosen, deletes all conflict copies, re-reads.
  - `DELETE /api/items/:id` → `204`; removes html, json, conflict copies; `store.remove`.
  - `GET /api/tags` → `store.tags()`.
  - `GET /items/:id/page` → html file with `Content-Type: text/html; charset=utf-8` and `Content-Security-Policy: sandbox`; `404` when missing.
  - `GET /items/:id` → `public/item.html`; `GET /` → `public/index.html`; other `public/*` static.
  - CORS: `Access-Control-Allow-Origin` echoes origins starting with `chrome-extension://` or `moz-extension://`; allows `Authorization, Content-Type` headers and `POST, OPTIONS`.
  - `openUrl` = `http://127.0.0.1:${config.port}/items/${id}?new=1`.

- [ ] **Step 1: Write the failing test**

`tests/app.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { Store } from "../src/store.js";

const HTML = "<html><!--\n Page saved with SingleFile \n url: https://h.example/ \n--><head><title>Title</title></head><body>hi</body></html>";

async function setup() {
  const archiveDir = await mkdtemp(join(tmpdir(), "wa-"));
  const store = new Store(":memory:");
  const config = { archiveDir, dataDir: archiveDir, port: 8765, machineName: "mac" };
  const app = createApp({ config, store });
  return { app, store, archiveDir };
}

async function upload(app, url = "https://form.example/") {
  const form = new FormData();
  form.append("file", new Blob([HTML], { type: "text/html" }), "Title.html");
  form.append("url", url);
  const res = await app.request("/api/singlefile", { method: "POST", body: form, headers: { Origin: "chrome-extension://abc" } });
  return res;
}

test("POST /api/singlefile stores the page and returns openUrl with CORS", async () => {
  const { app, store } = await setup();
  const res = await upload(app);
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("access-control-allow-origin"), "chrome-extension://abc");
  const body = await res.json();
  assert.equal(body.openUrl, `http://127.0.0.1:8765/items/${body.id}?new=1`);
  assert.equal(store.get(body.id).url, "https://form.example/");
});

test("POST /api/singlefile without file is 400", async () => {
  const { app } = await setup();
  const res = await app.request("/api/singlefile", { method: "POST", body: new FormData() });
  assert.equal(res.status, 400);
});

test("list, get, patch, tags and page serving", async () => {
  const { app } = await setup();
  const { id } = await (await upload(app)).json();
  const list = await (await app.request("/api/items?q=Title")).json();
  assert.equal(list.total, 1);
  const patch = await app.request(`/api/items/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ memo: "note", tags: ["Research", "js"] }) });
  assert.equal(patch.status, 200);
  const item = await (await app.request(`/api/items/${id}`)).json();
  assert.equal(item.memo, "note");
  assert.deepEqual(item.tags, ["research", "js"]);
  assert.ok(item.updatedAt);
  assert.deepEqual(await (await app.request("/api/tags")).json(), [{ tag: "js", count: 1 }, { tag: "research", count: 1 }]);
  const page = await app.request(`/items/${id}/page`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-security-policy"), "sandbox");
  assert.equal(await page.text(), HTML);
  assert.equal((await app.request("/api/items/01J7ZK4M3N5P6Q7R8S9T0V1W2X")).status, 404);
});

test("conflict copies are exposed and resolved", async () => {
  const { app, archiveDir, store } = await setup();
  const { id } = await (await upload(app)).json();
  const item = store.get(id);
  const dir = join(archiveDir, item.relDir);
  await writeFile(join(dir, `${id} (conflicted copy).json`), JSON.stringify({ id, memo: "from other machine", tags: ["other"] }));
  await app.request(`/api/items/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
  const detail = await (await app.request(`/api/items/${id}`)).json();
  assert.equal(detail.status, "conflict");
  assert.equal(detail.conflicts[0].memo, "from other machine");
  const resolved = await (await app.request(`/api/items/${id}/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ choose: `conflict:${id} (conflicted copy).json` }) })).json();
  assert.equal(resolved.status, "ok");
  assert.equal(resolved.memo, "from other machine");
  assert.deepEqual((await readdir(dir)).sort(), [`${id}.html`, `${id}.json`]);
});

test("broken sidecar can be repaired with PATCH and DELETE removes files", async () => {
  const { app, archiveDir, store } = await setup();
  const { id } = await (await upload(app)).json();
  const dir = join(archiveDir, store.get(id).relDir);
  await writeFile(join(dir, `${id}.json`), "{ broken");
  await app.request(`/api/items/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://fixed.example/", title: "Fixed" }) });
  const item = await (await app.request(`/api/items/${id}`)).json();
  assert.equal(item.status, "ok");
  assert.equal(item.title, "Fixed");
  assert.equal((await app.request(`/api/items/${id}`, { method: "DELETE" })).status, 204);
  assert.deepEqual(await readdir(dir), []);
  assert.equal(store.get(id), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL, cannot find module `../src/app.js`

- [ ] **Step 3: Implement the app**

`src/app.js`:

```js
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFile, readdir, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ingest } from "./ingest.js";
import { readItem } from "./item.js";
import { ULID_RE, classifyFile, normalizeTags, readSidecar, writeSidecarAtomic, sidecarDefaults, toIsoWithOffset } from "./sidecar.js";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

export function createApp({ config, store }) {
  const app = new Hono();
  const ctx = { archiveDir: config.archiveDir, machineName: config.machineName, store };

  app.use("/api/*", cors({
    origin: (origin) => (origin && /^(chrome|moz)-extension:\/\//.test(origin) ? origin : ""),
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"]
  }));

  app.post("/api/singlefile", async (c) => {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) {
      return c.json({ error: "multipart field 'file' is required" }, 400);
    }
    const html = Buffer.from(await file.arrayBuffer());
    const url = typeof body.url === "string" ? body.url : "";
    const item = await ingest(ctx, { html, url, filename: file.name });
    return c.json({ id: item.id, openUrl: `http://127.0.0.1:${config.port}/items/${item.id}?new=1` }, 201);
  });

  app.get("/api/items", (c) => {
    const { q = "", tag = "", status = "", page = "1", limit = "50" } = c.req.query();
    return c.json(store.list({ q, tag, status, page: Number(page), limit: Number(limit) }));
  });

  app.get("/api/tags", (c) => c.json(store.tags()));

  app.get("/api/items/:id", async (c) => {
    const item = await locate(c.req.param("id"));
    if (!item) {
      return c.json({ error: "not found" }, 404);
    }
    const conflicts = [];
    for (const file of item.conflictFiles) {
      try {
        const data = await readSidecar(join(config.archiveDir, item.relDir, file));
        conflicts.push({ file, memo: typeof data.memo === "string" ? data.memo : "", tags: normalizeTags(data.tags), updatedAt: data.updatedAt ?? null });
      } catch {
        conflicts.push({ file, memo: null, tags: [], updatedAt: null });
      }
    }
    return c.json({ ...item, conflicts });
  });

  app.patch("/api/items/:id", async (c) => {
    const item = await locate(c.req.param("id"));
    if (!item) {
      return c.json({ error: "not found" }, 404);
    }
    const patch = await c.req.json().catch(() => ({}));
    const jsonPath = join(config.archiveDir, item.relDir, `${item.id}.json`);
    let sidecar;
    try {
      sidecar = await readSidecar(jsonPath);
    } catch {
      sidecar = sidecarDefaults({ id: item.id, savedOn: config.machineName });
    }
    if (typeof patch.memo === "string") {
      sidecar.memo = patch.memo;
    }
    if (Array.isArray(patch.tags)) {
      sidecar.tags = normalizeTags(patch.tags);
    }
    if (typeof patch.url === "string") {
      sidecar.url = patch.url;
    }
    if (typeof patch.title === "string") {
      sidecar.title = patch.title;
    }
    sidecar.id = item.id;
    sidecar.updatedAt = toIsoWithOffset();
    await writeSidecarAtomic(jsonPath, sidecar);
    return c.json(await refresh(item));
  });

  app.post("/api/items/:id/resolve", async (c) => {
    const item = await locate(c.req.param("id"));
    if (!item) {
      return c.json({ error: "not found" }, 404);
    }
    const { choose } = await c.req.json().catch(() => ({}));
    const dir = join(config.archiveDir, item.relDir);
    if (typeof choose === "string" && choose.startsWith("conflict:")) {
      const file = choose.slice("conflict:".length);
      if (!item.conflictFiles.includes(file)) {
        return c.json({ error: "unknown conflict file" }, 400);
      }
      const chosen = await readSidecar(join(dir, file));
      let sidecar;
      try {
        sidecar = await readSidecar(join(dir, `${item.id}.json`));
      } catch {
        sidecar = sidecarDefaults({ id: item.id, savedOn: config.machineName });
      }
      sidecar.memo = typeof chosen.memo === "string" ? chosen.memo : sidecar.memo;
      sidecar.tags = normalizeTags(chosen.tags);
      sidecar.updatedAt = toIsoWithOffset();
      await writeSidecarAtomic(join(dir, `${item.id}.json`), sidecar);
    } else if (choose !== "main") {
      return c.json({ error: "choose must be 'main' or 'conflict:<file>'" }, 400);
    }
    for (const file of item.conflictFiles) {
      await unlink(join(dir, file)).catch(() => {});
    }
    return c.json(await refresh(item));
  });

  app.delete("/api/items/:id", async (c) => {
    const item = await locate(c.req.param("id"));
    if (!item) {
      return c.json({ error: "not found" }, 404);
    }
    const dir = join(config.archiveDir, item.relDir);
    for (const name of await readdir(dir)) {
      if (classifyFile(name).id === item.id) {
        await unlink(join(dir, name)).catch(() => {});
      }
    }
    store.remove(item.id);
    return c.body(null, 204);
  });

  app.get("/items/:id/page", async (c) => {
    const item = await locate(c.req.param("id"));
    if (!item || !item.hasHtml) {
      return c.text("not found", 404);
    }
    const html = await readFile(join(config.archiveDir, item.relDir, `${item.id}.html`));
    return c.body(html, 200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "sandbox" });
  });

  app.get("/items/:id", async (c) => c.html(await readFile(join(PUBLIC_DIR, "item.html"), "utf8")));
  app.get("/", async (c) => c.html(await readFile(join(PUBLIC_DIR, "index.html"), "utf8")));
  app.use("/*", serveStatic({ root: "./public" }));

  async function locate(id) {
    if (!ULID_RE.test(id)) {
      return null;
    }
    const indexed = store.get(id);
    return indexed ? readItem(ctx, indexed.relDir, id) : null;
  }

  async function refresh(item) {
    const fresh = await readItem(ctx, item.relDir, item.id);
    if (fresh) {
      store.upsert(fresh);
    } else {
      store.remove(item.id);
    }
    return fresh;
  }

  return app;
}
```

Note: `serveStatic({ root: "./public" })` resolves relative to the process working directory; `npm start` runs from the repo root, which is what the README documents.

- [ ] **Step 4: Write the server entry**

`src/server.js`:

```js
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { rebuildIndex } from "./scanner.js";
import { startWatcher } from "./watcher.js";
import { createApp } from "./app.js";

const config = loadConfig();
await mkdir(config.dataDir, { recursive: true });
await mkdir(join(config.archiveDir, "items"), { recursive: true });
const store = new Store(join(config.dataDir, "index.sqlite"));
const count = await rebuildIndex({ archiveDir: config.archiveDir, machineName: config.machineName, store });
console.log(`indexed ${count} items from ${config.archiveDir}`);
const watcher = startWatcher({ archiveDir: config.archiveDir, machineName: config.machineName, store });
const app = createApp({ config, store });
serve({ fetch: app.fetch, hostname: "127.0.0.1", port: config.port }, () => {
  console.log(`webarchive listening on http://127.0.0.1:${config.port}/ (${config.machineName})`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await watcher.close();
    store.close();
    process.exit(0);
  });
}
```

- [ ] **Step 5: Write README.md**

```markdown
# webarchive-server

SingleFile でキャプチャしたページを Dropbox 共有フォルダに保存し、メモ・タグを付けて検索するローカルサーバ。

## 起動

```bash
npm install
ARCHIVE_DIR=~/Dropbox/WebArchive MACHINE_NAME=macbook npm start
```

`config.json`(リポジトリ直下、git 管理外)でも指定できる。環境変数が優先。

```json
{ "archiveDir": "/Users/me/Dropbox/WebArchive", "port": 8765, "machineName": "macbook" }
```

索引 SQLite は `~/.local/share/webarchive/index.sqlite`(`DATA_DIR` で変更可)。削除しても起動時に再構築される。

## SingleFile の設定

| 設定 | 値 |
|---|---|
| 保存先 | REST form API |
| URL | `http://127.0.0.1:8765/api/singlefile` |
| ファイルのフィールド名 | `file` |
| URL のフィールド名 | `url` |
| 認証トークン | 任意(検証しない) |
| 保存後にレスポンスの URL を開く | 有効 |

## テスト

```bash
npm test
```
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: all passing. The static routes in `app.test.js` are not exercised yet; `public/` is created in Task 8.

- [ ] **Step 7: Smoke test the entry point**

```bash
mkdir -p /tmp/wa-smoke && ARCHIVE_DIR=/tmp/wa-smoke DATA_DIR=/tmp/wa-smoke/data PORT=8765 npm start &
sleep 1
printf '<html><head><title>Smoke</title></head><body>x</body></html>' > /tmp/wa-smoke/page.html
curl -s -F file=@/tmp/wa-smoke/page.html -F url=https://example.com/ http://127.0.0.1:8765/api/singlefile
curl -s http://127.0.0.1:8765/api/items | head -c 300
kill %1
```

Expected: first curl prints `{"id":"01...","openUrl":"http://127.0.0.1:8765/items/01...?new=1"}`, second prints a list with `"total":1`.

- [ ] **Step 8: Commit**

```bash
git add src/app.js src/server.js tests/app.test.js README.md
git commit -m "add the HTTP API, server entry point and README"
```

---

### Task 8: Web UI

**Files:**
- Create: `public/app.css`, `public/index.html`, `public/list.js`, `public/item.html`, `public/item.js`
- Test: `tests/app.test.js` (add a static-serving assertion), manual check in Chrome against the mockup.

**Interfaces:**
- Consumes: the API from Task 7 exactly as specified there.

- [ ] **Step 1: Add a failing static-route test**

Append to `tests/app.test.js`:

```js
test("serves the list and item pages", async () => {
  const { app } = await setup();
  const home = await app.request("/");
  assert.equal(home.status, 200);
  assert.match(await home.text(), /id="list"/);
  const item = await app.request("/items/01J7ZK4M3N5P6Q7R8S9T0V1W2X");
  assert.equal(item.status, 200);
  assert.match(await item.text(), /id="memo"/);
});
```

Run: `npm test` → Expected: FAIL with ENOENT for `public/index.html`.

- [ ] **Step 2: Write the shared stylesheet**

`public/app.css` (direction A tokens from the mockup):

```css
:root {
  --bg: #f4f4f1; --panel: #ffffff; --line: #d9d9d4; --line-soft: #e6e6e1;
  --ink: #1c1c1a; --muted: #6b6b66; --faint: #9a9a94;
  --accent: #1f5f8b; --accent-bg: #e8eef3; --danger: #a3412c; --danger-bg: #fdf3ef; --ok: #3a8f5c;
  --mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;
}
* { box-sizing: border-box; }
body { margin: 0; font-family: "IBM Plex Sans JP", "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif; font-size: 13px; color: var(--ink); background: var(--bg); }
a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
button, input, textarea { font: inherit; color: inherit; }
.mono { font-family: var(--mono); font-size: 12px; }
header.top { display: flex; align-items: center; gap: 20px; height: 48px; padding: 0 20px; background: var(--panel); border-bottom: 1px solid var(--line); }
header.top .brand { font-weight: 600; font-size: 15px; letter-spacing: .02em; }
header.top .status { margin-left: auto; color: var(--muted); font-size: 12px; display: flex; gap: 10px; align-items: center; }
.dot { width: 8px; height: 8px; border-radius: 4px; background: var(--ok); display: inline-block; }
.search { display: flex; align-items: center; gap: 8px; flex: 1; max-width: 640px; height: 32px; padding: 0 10px; background: var(--bg); border: 1px solid var(--line); border-radius: 4px; }
.search input { flex: 1; border: 0; background: transparent; outline: none; }
.layout { display: flex; height: calc(100vh - 48px); }
aside.side { width: 220px; padding: 16px 12px; background: var(--panel); border-right: 1px solid var(--line); overflow-y: auto; }
aside.side h3 { margin: 12px 8px 4px; font-size: 11px; font-weight: 600; color: var(--muted); letter-spacing: .08em; }
aside.side a.filter { display: flex; justify-content: space-between; padding: 5px 8px; border-radius: 4px; color: var(--ink); }
aside.side a.filter.active { background: var(--accent-bg); color: var(--accent); }
aside.side a.filter.danger { color: var(--danger); }
aside.side a.filter span:last-child { font-family: var(--mono); font-size: 12px; color: var(--muted); }
main.list { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.toolbar { display: flex; align-items: center; gap: 16px; height: 36px; padding: 0 20px; font-size: 12px; color: var(--muted); border-bottom: 1px solid var(--line); }
.toolbar .pager { margin-left: auto; display: flex; gap: 8px; align-items: center; }
.rows { overflow-y: auto; }
.row { display: grid; grid-template-columns: 1fr 260px 120px; gap: 16px; align-items: center; padding: 9px 20px; background: var(--panel); border-bottom: 1px solid var(--line-soft); color: inherit; }
.row:hover { background: var(--accent-bg); text-decoration: none; }
.row.conflict { background: var(--danger-bg); }
.row .title { font-size: 14px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row .sub { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row .date { font-family: var(--mono); font-size: 12px; color: var(--muted); text-align: right; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { font-size: 11px; padding: 2px 7px; border-radius: 3px; background: var(--accent-bg); color: var(--accent); }
.chip.none { background: #f0ede4; color: var(--muted); }
.badge { font-size: 11px; padding: 1px 6px; border-radius: 3px; color: #fff; background: var(--danger); margin-right: 8px; }
.badge.pending { background: var(--muted); }
.empty { padding: 40px; color: var(--muted); text-align: center; }
/* item screen */
aside.detail { width: 420px; display: flex; flex-direction: column; gap: 20px; padding: 24px; background: var(--panel); border-right: 1px solid var(--line); overflow-y: auto; }
aside.detail h1 { margin: 0; font-size: 18px; font-weight: 600; line-height: 1.4; }
aside.detail .url { font-size: 12px; word-break: break-all; line-height: 1.5; }
aside.detail .meta { display: flex; gap: 14px; font-family: var(--mono); font-size: 11px; color: var(--muted); }
.field { display: flex; flex-direction: column; gap: 6px; }
.field label { font-size: 11px; font-weight: 600; color: var(--muted); letter-spacing: .08em; }
.field .hint { font-size: 11px; color: var(--faint); }
textarea#memo { min-height: 160px; padding: 10px 12px; font-size: 14px; line-height: 1.7; border: 1px solid var(--line); border-radius: 4px; resize: vertical; }
textarea#memo:focus, .tagbox:focus-within { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-bg); }
.tagbox { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 6px 8px; border: 1px solid var(--line); border-radius: 4px; position: relative; }
.tagbox .chip { display: flex; align-items: center; gap: 6px; font-size: 12px; padding: 3px 8px; }
.tagbox .chip button { border: 0; background: none; padding: 0; cursor: pointer; color: inherit; line-height: 1; }
.tagbox input { flex: 1; min-width: 80px; border: 0; outline: none; padding: 3px 4px; }
.suggest { position: absolute; left: 0; top: 100%; margin-top: 4px; width: 240px; background: var(--panel); border: 1px solid var(--line); border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,.08); z-index: 2; }
.suggest div { display: flex; justify-content: space-between; padding: 7px 10px; cursor: pointer; }
.suggest div.active { background: var(--accent-bg); }
.suggest div span:last-child { font-family: var(--mono); font-size: 11px; color: var(--muted); }
.suggest div.create { color: var(--muted); border-top: 1px solid var(--line-soft); }
.actions { margin-top: auto; display: flex; gap: 8px; }
.btn { font-size: 13px; padding: 7px 12px; border-radius: 4px; border: 1px solid var(--line); background: var(--panel); cursor: pointer; }
.btn.danger { margin-left: auto; border-color: #e0b8ae; color: var(--danger); }
.preview { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.preview .bar { display: flex; align-items: center; gap: 12px; height: 32px; padding: 0 16px; font-size: 12px; color: var(--muted); border-bottom: 1px solid var(--line); }
.preview .bar a { margin-left: auto; }
.preview iframe { flex: 1; margin: 16px; border: 1px solid var(--line); background: var(--panel); }
.notice { padding: 10px 12px; border-radius: 4px; font-size: 12px; line-height: 1.6; }
.notice.conflict { background: var(--danger-bg); border: 1px solid #e0b8ae; }
.notice.broken { background: #fbf6e5; border: 1px solid #e5d7a3; }
.notice .choice { margin-top: 8px; padding: 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--panel); }
.notice .choice pre { margin: 6px 0; white-space: pre-wrap; font: inherit; }
```

- [ ] **Step 3: Write the list screen**

`public/index.html`:

```html
<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WebArchive</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header class="top">
  <div class="brand">WebArchive</div>
  <form class="search" id="searchForm">
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#6b6b66" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"></circle><path d="M10.5 10.5 14 14"></path></svg>
    <input id="q" type="search" placeholder="タイトル・URL・メモ・タグを検索" autocomplete="off">
  </form>
  <div class="status mono" id="summary"></div>
</header>
<div class="layout">
  <aside class="side">
    <h3>状態</h3>
    <nav id="statusNav"></nav>
    <h3>タグ</h3>
    <nav id="tagNav"></nav>
  </aside>
  <main class="list">
    <div class="toolbar">
      <div>並び: 保存日 新しい順</div>
      <div class="pager mono"><a href="#" id="prev">←</a><span id="range"></span><a href="#" id="next">→</a></div>
    </div>
    <div class="rows" id="list"></div>
  </main>
</div>
<script src="/list.js" type="module"></script>
</body>
</html>
```

`public/list.js`:

```js
const state = { q: "", tag: "", status: "", page: 1, limit: 50 };
const qInput = document.getElementById("q");
const listEl = document.getElementById("list");

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  state.q = params.get("q") ?? "";
  state.tag = params.get("tag") ?? "";
  state.status = params.get("status") ?? "";
  state.page = Number(params.get("page") ?? 1) || 1;
  qInput.value = state.q;
}

function writeHash() {
  const params = new URLSearchParams();
  for (const key of ["q", "tag", "status"]) {
    if (state[key]) {
      params.set(key, state[key]);
    }
  }
  if (state.page > 1) {
    params.set("page", String(state.page));
  }
  history.replaceState(null, "", "#" + params.toString());
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") {
      node.className = value;
    } else if (key === "href") {
      node.setAttribute("href", value);
    } else {
      node[key] = value;
    }
  }
  for (const child of children) {
    node.append(child);
  }
  return node;
}

function domain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url ?? "";
  }
}

function filterLink(label, count, active, patch, extraClass = "") {
  const link = el("a", { class: `filter ${active ? "active" : ""} ${extraClass}`.trim(), href: "#" }, [el("span", {}, [label]), el("span", {}, [String(count)])]);
  link.addEventListener("click", (event) => {
    event.preventDefault();
    Object.assign(state, patch, { page: 1 });
    load();
  });
  return link;
}

async function load() {
  writeHash();
  const params = new URLSearchParams({ q: state.q, tag: state.tag, status: state.status, page: String(state.page), limit: String(state.limit) });
  const [result, tags, all, untagged, conflicts] = await Promise.all([
    fetch("/api/items?" + params).then((r) => r.json()),
    fetch("/api/tags").then((r) => r.json()),
    fetch("/api/items?limit=1").then((r) => r.json()),
    fetch("/api/items?limit=1&tag=-").then((r) => r.json()),
    fetch("/api/items?limit=1&status=conflict").then((r) => r.json())
  ]);
  renderSide(tags, all.total, untagged.total, conflicts.total);
  renderList(result);
}

function renderSide(tags, total, untagged, conflicts) {
  const statusNav = document.getElementById("statusNav");
  statusNav.replaceChildren(
    filterLink("すべて", total, !state.tag && !state.status, { tag: "", status: "" }),
    filterLink("タグなし", untagged, state.tag === "-", { tag: "-", status: "" }),
    filterLink("競合あり", conflicts, state.status === "conflict", { tag: "", status: "conflict" }, "danger")
  );
  const tagNav = document.getElementById("tagNav");
  tagNav.replaceChildren(...tags.map(({ tag, count }) => filterLink(tag, count, state.tag === tag, { tag, status: "" })));
  document.getElementById("summary").textContent = `${total.toLocaleString()} items`;
}

function renderList({ items, total, page, limit }) {
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(total, page * limit);
  document.getElementById("range").textContent = `${from}–${to} / ${total}`;
  document.getElementById("prev").style.visibility = page > 1 ? "visible" : "hidden";
  document.getElementById("next").style.visibility = to < total ? "visible" : "hidden";
  if (items.length === 0) {
    listEl.replaceChildren(el("div", { class: "empty" }, ["該当する項目はありません"]));
    return;
  }
  listEl.replaceChildren(...items.map((item) => {
    const title = el("div", { class: "title" });
    if (item.status === "conflict") {
      title.append(el("span", { class: "badge" }, ["競合"]));
    } else if (item.status === "pending") {
      title.append(el("span", { class: "badge pending" }, ["同期中"]));
    } else if (item.status === "broken") {
      title.append(el("span", { class: "badge" }, ["要修復"]));
    }
    title.append(item.title || item.url || item.id);
    const subText = [domain(item.url), item.memo ? item.memo.split("\n")[0] : ""].filter(Boolean).join(" · ");
    const chips = el("div", { class: "chips" }, item.tags.length
      ? item.tags.map((tag) => el("span", { class: "chip" }, [tag]))
      : [el("span", { class: "chip none" }, ["タグなし"])]);
    return el("a", { class: `row ${item.status === "conflict" ? "conflict" : ""}`, href: `/items/${item.id}` }, [
      el("div", { style: "min-width:0; display:flex; flex-direction:column; gap:3px;" }, [title, el("div", { class: "sub" }, [subText])]),
      chips,
      el("div", { class: "date" }, [(item.savedAt ?? "").slice(0, 10)])
    ]);
  }));
}

document.getElementById("searchForm").addEventListener("submit", (event) => {
  event.preventDefault();
  state.q = qInput.value.trim();
  state.page = 1;
  load();
});
document.getElementById("prev").addEventListener("click", (event) => { event.preventDefault(); state.page--; load(); });
document.getElementById("next").addEventListener("click", (event) => { event.preventDefault(); state.page++; load(); });
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && document.activeElement !== qInput) {
    event.preventDefault();
    qInput.focus();
  }
});

readHash();
load();
```

- [ ] **Step 4: Write the item screen**

`public/item.html`:

```html
<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WebArchive</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header class="top">
  <div class="brand">WebArchive</div>
  <a href="/">← 一覧へ戻る</a>
  <div class="status" id="saveStatus"><span class="dot"></span><span>保存済み</span></div>
</header>
<div class="layout">
  <aside class="detail">
    <div id="notice"></div>
    <div style="display:flex; flex-direction:column; gap:8px;">
      <h1 id="title"></h1>
      <a class="url" id="url" target="_blank" rel="noopener"></a>
      <div class="meta"><span id="savedAt"></span><span id="savedOn"></span></div>
    </div>
    <div class="field">
      <label for="memo">メモ</label>
      <textarea id="memo"></textarea>
      <div class="hint">フォーカスが外れると保存 · Cmd+S</div>
    </div>
    <div class="field">
      <label for="tagInput">タグ</label>
      <div class="tagbox" id="tagbox">
        <input id="tagInput" placeholder="タグを追加…" autocomplete="off">
      </div>
    </div>
    <div class="actions">
      <a class="btn" id="openOriginal" target="_blank" rel="noopener">元ページを開く</a>
      <a class="btn" id="download" download>HTML をダウンロード</a>
      <button class="btn danger" id="delete">削除</button>
    </div>
  </aside>
  <section class="preview">
    <div class="bar"><span>保存したページ</span><span class="mono">sandbox</span><a id="openPage" target="_blank" rel="noopener">新しいタブで開く</a></div>
    <iframe id="frame" sandbox=""></iframe>
  </section>
</div>
<script src="/item.js" type="module"></script>
</body>
</html>
```

`public/item.js`:

```js
const id = location.pathname.split("/").pop();
const isNew = new URLSearchParams(location.search).get("new") === "1";
const memoEl = document.getElementById("memo");
const tagInput = document.getElementById("tagInput");
const tagbox = document.getElementById("tagbox");
const saveStatus = document.getElementById("saveStatus");
let item = null;
let tags = [];
let allTags = [];
let suggestIndex = 0;
let dirty = false;

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  if (!res.ok && res.status !== 204) {
    throw new Error(`${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

function setStatus(text, color) {
  saveStatus.querySelector(".dot").style.background = color;
  saveStatus.querySelector("span:last-child").textContent = text;
}

async function load() {
  [item, allTags] = await Promise.all([api(`/api/items/${id}`), api("/api/tags")]);
  tags = [...item.tags];
  document.title = `${item.title ?? item.id} – WebArchive`;
  document.getElementById("title").textContent = item.title ?? "(タイトルなし)";
  const urlEl = document.getElementById("url");
  urlEl.textContent = item.url ?? "";
  urlEl.href = item.url ?? "#";
  document.getElementById("openOriginal").href = item.url ?? "#";
  document.getElementById("savedAt").textContent = (item.savedAt ?? "").replace("T", " ").slice(0, 16);
  document.getElementById("savedOn").textContent = item.savedOn ?? "";
  document.getElementById("download").href = `/items/${id}/page`;
  document.getElementById("download").setAttribute("download", `${item.title ?? item.id}.html`);
  document.getElementById("openPage").href = `/items/${id}/page`;
  document.getElementById("frame").src = item.hasHtml ? `/items/${id}/page` : "about:blank";
  memoEl.value = item.memo ?? "";
  renderTags();
  renderNotice();
  if (isNew) {
    memoEl.focus();
  }
}

function renderNotice() {
  const notice = document.getElementById("notice");
  notice.replaceChildren();
  if (item.status === "conflict") {
    const box = document.createElement("div");
    box.className = "notice conflict";
    box.textContent = "別のマシンで同時に編集されたため、Dropbox が競合コピーを作成しました。採用する内容を選んでください。";
    box.append(choice("このマシンの内容(現在の表示)", item.memo, item.tags, "main"));
    for (const conflict of item.conflicts) {
      box.append(choice(conflict.file, conflict.memo ?? "(読み取り不能)", conflict.tags, `conflict:${conflict.file}`));
    }
    notice.append(box);
  } else if (item.status === "broken") {
    const box = document.createElement("div");
    box.className = "notice broken";
    box.innerHTML = "メタデータ(JSON)が壊れています。URL とタイトルを入力して保存すると修復されます。<br>";
    const url = Object.assign(document.createElement("input"), { placeholder: "URL", style: "width:100%; margin-top:6px;" });
    const title = Object.assign(document.createElement("input"), { placeholder: "タイトル", style: "width:100%; margin-top:6px;" });
    const button = Object.assign(document.createElement("button"), { className: "btn", textContent: "修復して保存", style: "margin-top:6px;" });
    button.addEventListener("click", async () => {
      await api(`/api/items/${id}`, { method: "PATCH", body: JSON.stringify({ url: url.value, title: title.value, memo: memoEl.value, tags }) });
      await load();
    });
    box.append(url, title, button);
    notice.append(box);
  } else if (item.status === "pending") {
    const box = document.createElement("div");
    box.className = "notice broken";
    box.textContent = "HTML がまだ同期されていません(Dropbox の到着待ち)。";
    notice.append(box);
  }
}

function choice(label, memo, chosenTags, choose) {
  const box = document.createElement("div");
  box.className = "choice";
  const pre = document.createElement("pre");
  pre.textContent = memo || "(メモなし)";
  const button = Object.assign(document.createElement("button"), { className: "btn", textContent: "この内容を採用" });
  button.addEventListener("click", async () => {
    await api(`/api/items/${id}/resolve`, { method: "POST", body: JSON.stringify({ choose }) });
    await load();
  });
  box.append(Object.assign(document.createElement("div"), { textContent: label, style: "font-weight:600;" }), pre,
    Object.assign(document.createElement("div"), { textContent: chosenTags.length ? chosenTags.join(", ") : "(タグなし)", style: "color:#6b6b66; margin-bottom:6px;" }), button);
  return box;
}

function renderTags() {
  for (const chip of tagbox.querySelectorAll(".chip")) {
    chip.remove();
  }
  for (const tag of tags) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = tag;
    const remove = Object.assign(document.createElement("button"), { textContent: "×", title: "削除" });
    remove.addEventListener("click", () => {
      tags = tags.filter((t) => t !== tag);
      renderTags();
      save();
    });
    chip.append(remove);
    tagbox.insertBefore(chip, tagInput);
  }
}

function suggestions() {
  const text = tagInput.value.trim().toLowerCase();
  if (!text) {
    return [];
  }
  const matches = allTags.filter(({ tag }) => tag.includes(text) && !tags.includes(tag)).slice(0, 8);
  if (!matches.some(({ tag }) => tag === text) && !tags.includes(text)) {
    matches.push({ tag: text, count: null });
  }
  return matches;
}

function renderSuggest() {
  document.querySelector(".suggest")?.remove();
  const list = suggestions();
  if (list.length === 0) {
    return;
  }
  suggestIndex = Math.min(suggestIndex, list.length - 1);
  const box = document.createElement("div");
  box.className = "suggest";
  list.forEach(({ tag, count }, index) => {
    const row = document.createElement("div");
    row.className = (index === suggestIndex ? "active" : "") + (count === null ? " create" : "");
    row.append(Object.assign(document.createElement("span"), { textContent: count === null ? `新しいタグ "${tag}" を作成` : tag }),
      Object.assign(document.createElement("span"), { textContent: count === null ? "↵" : String(count) }));
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      addTag(tag);
    });
    box.append(row);
  });
  tagbox.append(box);
}

function addTag(tag) {
  tag = tag.trim().toLowerCase();
  if (tag && !tags.includes(tag)) {
    tags.push(tag);
    renderTags();
    save();
  }
  tagInput.value = "";
  suggestIndex = 0;
  renderSuggest();
}

async function save() {
  dirty = false;
  setStatus("保存中…", "#9a9a94");
  try {
    item = await api(`/api/items/${id}`, { method: "PATCH", body: JSON.stringify({ memo: memoEl.value, tags }) });
    allTags = await api("/api/tags");
    setStatus(`保存済み ${(item.updatedAt ?? "").slice(11, 19)}`, "#3a8f5c");
  } catch (error) {
    setStatus("保存に失敗: " + error.message, "#a3412c");
  }
}

memoEl.addEventListener("input", () => { dirty = true; setStatus("未保存", "#9a9a94"); });
memoEl.addEventListener("blur", () => { if (dirty) { save(); } });
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "s") {
    event.preventDefault();
    if (document.activeElement === tagInput && tagInput.value.trim()) {
      addTag(tagInput.value);
    }
    save();
  }
});
tagInput.addEventListener("input", () => { suggestIndex = 0; renderSuggest(); });
tagInput.addEventListener("blur", () => setTimeout(() => document.querySelector(".suggest")?.remove(), 100));
tagInput.addEventListener("keydown", (event) => {
  const list = suggestions();
  if (event.key === "Enter") {
    event.preventDefault();
    if (list.length) {
      addTag(list[suggestIndex].tag);
    }
  } else if (event.key === "ArrowDown" && list.length) {
    event.preventDefault();
    suggestIndex = (suggestIndex + 1) % list.length;
    renderSuggest();
  } else if (event.key === "ArrowUp" && list.length) {
    event.preventDefault();
    suggestIndex = (suggestIndex - 1 + list.length) % list.length;
    renderSuggest();
  } else if (event.key === "Backspace" && !tagInput.value && tags.length) {
    tags.pop();
    renderTags();
    save();
  } else if (event.key === "Escape") {
    tagInput.value = "";
    renderSuggest();
  }
});
document.getElementById("delete").addEventListener("click", async () => {
  if (window.confirm("この項目と保存した HTML を削除します。よろしいですか?")) {
    await api(`/api/items/${id}`, { method: "DELETE" });
    location.href = "/";
  }
});
window.addEventListener("beforeunload", (event) => {
  if (dirty) {
    event.preventDefault();
  }
});

load().catch((error) => {
  document.getElementById("notice").textContent = "読み込みに失敗しました: " + error.message;
});
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: all passing (including the new static-route test).

- [ ] **Step 6: Manual check in Chrome**

```bash
mkdir -p /tmp/wa-ui && ARCHIVE_DIR=/tmp/wa-ui DATA_DIR=/tmp/wa-ui/data npm start
```

In another shell upload three pages with `curl -F file=@... -F url=...` (as in Task 7 step 7), then open `http://127.0.0.1:8765/`. Verify against the mockup:
- sidebar shows すべて / タグなし / 競合あり with counts and the tag list;
- rows show title, domain + memo first line, chips, date; clicking opens `/items/<id>`;
- on the item page: memo saves on blur and on Cmd+S (header shows 保存済み hh:mm:ss); typing in the tag box shows suggestions, Enter adds, Backspace on empty removes the last tag; the iframe shows the page; `?new=1` focuses the memo;
- create a conflict copy by hand (`cp <id>.json "<id> (conflicted copy).json"`), reload: the conflict notice appears and choosing one deletes the copy;
- corrupt `<id>.json`, reload: the repair notice appears and saving repairs it.

Fix anything that differs from the mockup or the spec before committing.

- [ ] **Step 7: Commit**

```bash
git add public tests/app.test.js
git commit -m "add the list and item web UI"
```

---

### Task 9: SingleFile option "open the response URL after upload"

Runs in `~/git/SingleFile` on a new branch `local-archive-open-url`.

**Files:**
- Modify: `src/core/bg/config.js:192-195` (defaults)
- Modify: `src/core/bg/downloads.js:277-279` and `:409-411` (both post-upload blocks, right after the `bookmarks.update` `if`)
- Modify: `src/ui/pages/options.html:396-400`
- Modify: `src/ui/bg/ui-options.js:394-400, 898-899, 1104-1112, 1366-1372`
- Modify: `_locales/en/messages.json:1140-1143`, `_locales/ja/messages.json:1140-1143`

**Interfaces:**
- Consumes: the server's `POST /api/singlefile` response `{ id, openUrl }`.
- Produces: option `saveToRestFormApiOpenResultUrl` (boolean, default `false`).

- [ ] **Step 1: Create the branch**

```bash
cd ~/git/SingleFile && git checkout -b local-archive-open-url
```

- [ ] **Step 2: Add the default option**

In `src/core/bg/config.js`, after the line `saveToRestFormApiToken: "",` add:

```js
	saveToRestFormApiOpenResultUrl: false,
```

- [ ] **Step 3: Open the URL after upload (both code paths)**

In `src/core/bg/downloads.js` there are two occurrences of:

```js
			if (message.bookmarkId && message.replaceBookmarkURL && response && response.url) {
				await bookmarks.update(message.bookmarkId, { url: response.url });
			}
```

Directly after **each** of them, add:

```js
			if (message.saveToRestFormApi && message.saveToRestFormApiOpenResultUrl && response && typeof response.openUrl == "string") {
				await browser.tabs.create({ url: response.openUrl, active: true });
			}
```

- [ ] **Step 4: Add the checkbox to the options page**

In `src/ui/pages/options.html`, after the `saveToRestFormApiUrlFieldNameInput` `<div class="option second-level">…</div>` block, add:

```html
			<div class="option second-level">
				<label for="saveToRestFormApiOpenResultUrlInput" id="saveToRestFormApiOpenResultUrlLabel"></label>
				<input type="checkbox" id="saveToRestFormApiOpenResultUrlInput">
			</div>
```

- [ ] **Step 5: Wire the checkbox in ui-options.js**

Next to the existing `saveToRestFormApiTokenLabel` / `saveToRestFormApiTokenInput` declarations add:

```js
const saveToRestFormApiOpenResultUrlLabel = document.getElementById("saveToRestFormApiOpenResultUrlLabel");
const saveToRestFormApiOpenResultUrlInput = document.getElementById("saveToRestFormApiOpenResultUrlInput");
```

Next to `saveToRestFormApiTokenLabel.textContent = browser.i18n.getMessage("optionRestFormApiToken");` add:

```js
saveToRestFormApiOpenResultUrlLabel.textContent = browser.i18n.getMessage("optionRestFormApiOpenResultUrl");
```

In the refresh block, after `saveToRestFormApiUrlFieldNameInput.disabled = !profileOptions.saveToRestFormApi;` add:

```js
	saveToRestFormApiOpenResultUrlInput.checked = profileOptions.saveToRestFormApiOpenResultUrl;
	saveToRestFormApiOpenResultUrlInput.disabled = !profileOptions.saveToRestFormApi;
```

In the save block, after `saveToRestFormApiUrlFieldName: saveToRestFormApiUrlFieldNameInput.value,` add:

```js
			saveToRestFormApiOpenResultUrl: saveToRestFormApiOpenResultUrlInput.checked,
```

- [ ] **Step 6: Add the i18n strings**

In `_locales/en/messages.json`, after the `optionRestFormApiToken` entry:

```json
	"optionRestFormApiOpenResultUrl": {
		"message": "open the URL returned by the server after saving",
		"description": "Options page label: 'open the URL returned by the server after saving'"
	},
```

In `_locales/ja/messages.json`, same position:

```json
	"optionRestFormApiOpenResultUrl": {
		"message": "保存後にサーバが返した URL を開く",
		"description": "Options page label: 'open the URL returned by the server after saving'"
	},
```

Other locales fall back to `default_locale` (`en`), so no further edits.

- [ ] **Step 7: Lint and build**

```bash
npx eslint src/core/bg/downloads.js src/core/bg/config.js src/ui/bg/ui-options.js
node -e 'for (const l of ["en","ja"]) JSON.parse(require("fs").readFileSync(`_locales/${l}/messages.json`))'
npm run build
```

Expected: no lint errors, both JSON files parse, build succeeds.

- [ ] **Step 8: Manual end-to-end check**

1. Start the server: `cd ~/git/webarchive-server && ARCHIVE_DIR=/tmp/wa-e2e npm start`.
2. Load the built extension unpacked in Chrome (`chrome://extensions` → Load unpacked → the SingleFile repo root, or the built zip's extracted folder).
3. In SingleFile options → destination: REST form API, URL `http://127.0.0.1:8765/api/singlefile`, file field `file`, URL field `url`, tick "open the URL returned by the server after saving".
4. Save any page. Expected: a new tab opens at `http://127.0.0.1:8765/items/<id>?new=1` with the memo field focused; the list at `/` shows the page.
5. Untick the option, save again. Expected: no tab opens, the item still appears in the list.

- [ ] **Step 9: Commit**

```bash
git add src/core/bg/config.js src/core/bg/downloads.js src/ui/pages/options.html src/ui/bg/ui-options.js _locales/en/messages.json _locales/ja/messages.json
git commit -m "add an option to open the URL returned by the REST form API after saving"
```

---

## Self-review notes

- Spec coverage: §1 data layout → Tasks 2, 6; §2 index/watch/conflict → Tasks 3, 4, 5, 7 (resolve); §3 server/API/CORS/CSP/atomic writes → Tasks 2, 7; §4 UI → Task 8; §5 extension → Task 9; §6 error handling (broken/pending/html-only/ingest cleanup) → Tasks 4, 6, 7, 8; §7 tests → each task; server unreachable → nothing to do (SingleFile shows its own error).
- `tag=-` is the API spelling for "untagged" used by both the store and the UI.
- `readItem` normalizes tags, so the store never sees un-normalized tags even from sidecars written by hand.
