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
