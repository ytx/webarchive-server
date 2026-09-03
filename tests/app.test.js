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

test("serves the list and item pages", async () => {
  const { app } = await setup();
  const home = await app.request("/");
  assert.equal(home.status, 200);
  assert.match(await home.text(), /id="list"/);
  const item = await app.request("/items/01J7ZK4M3N5P6Q7R8S9T0V1W2X");
  assert.equal(item.status, 200);
  assert.match(await item.text(), /id="memo"/);
});
