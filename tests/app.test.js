import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { Store } from "../src/store.js";

const HTML = "<html><!--\n Page saved with SingleFile \n url: https://h.example/ \n--><head><title>Title</title></head><body>hi</body></html>";

// app.request(path) leaves the Host header unset entirely (verified against
// Hono directly), which the Host-guard middleware would then reject. Since
// almost every test here is exercising something other than that guard, give
// app.request a default matching Host unless the caller supplies its own --
// which is exactly how the guard's own tests below probe a mismatched host.
function withDefaultHost(app, host) {
  const original = app.request.bind(app);
  app.request = (input, init = {}) => {
    const headers = new Headers(init.headers ?? {});
    if (!headers.has("host")) {
      headers.set("host", host);
    }
    return original(input, { ...init, headers });
  };
  return app;
}

function fakeOpenInBrowser() {
  const calls = [];
  const fn = (url) => {
    calls.push(url);
    return Promise.resolve(true);
  };
  fn.calls = calls;
  return fn;
}

function fakeRuntime(config) {
  const calls = [];
  return {
    config,
    calls,
    async apply(patch) {
      calls.push(patch);
      for (const key of ["archiveDir", "machineName", "openAfterSave"]) {
        if (patch[key] !== undefined && config.sources[key] !== "env") {
          config[key] = patch[key];
          config.sources[key] = "file";
        }
      }
      config.configured = Boolean(config.archiveDir);
      return { restartRequired: patch.port !== undefined && patch.port !== config.port };
    }
  };
}

async function setup({ openAfterSave = false, openInBrowser = fakeOpenInBrowser(), configured = true, sources = {} } = {}) {
  const archiveDir = await mkdtemp(join(tmpdir(), "wa-"));
  const store = new Store(":memory:");
  const config = {
    archiveDir: configured ? archiveDir : null,
    configured,
    dataDir: archiveDir,
    port: 8765,
    machineName: "mac",
    openAfterSave,
    configPath: join(archiveDir, "config.json"),
    sources: { archiveDir: "file", dataDir: "default", port: "default", machineName: "file", openAfterSave: "default", ...sources }
  };
  const runtime = fakeRuntime(config);
  const app = withDefaultHost(createApp({ config, store, openInBrowser, runtime, home: "/home/me" }), "127.0.0.1:8765");
  return { app, store, archiveDir, openInBrowser, runtime, config };
}

async function putSettings(app, body) {
  return app.request("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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

test("serves static assets from the public directory", async () => {
  const { app } = await setup();
  const css = await app.request("/app.css");
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type") ?? "", /text\/css/);
  const js = await app.request("/list.js");
  assert.equal(js.status, 200);
});

test("Host header guard rejects an unrecognized host and allows 127.0.0.1", async () => {
  const { app } = await setup();
  const forbidden = await app.request("/api/tags", { headers: { Host: "evil.example:8765" } });
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await forbidden.json(), { error: "forbidden host" });
  const ok = await app.request("/api/tags", { headers: { Host: "127.0.0.1:8765" } });
  assert.equal(ok.status, 200);
});

test("POST /api/singlefile rejects a non-extension Origin and allows a missing Origin", async () => {
  const { app } = await setup();
  const form = () => {
    const f = new FormData();
    f.append("file", new Blob([HTML], { type: "text/html" }), "Title.html");
    f.append("url", "https://form.example/");
    return f;
  };
  const forbidden = await app.request("/api/singlefile", { method: "POST", body: form(), headers: { Origin: "https://evil.example" } });
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await forbidden.json(), { error: "forbidden origin" });
  const noOrigin = await app.request("/api/singlefile", { method: "POST", body: form() });
  assert.equal(noOrigin.status, 201);
});

test("PATCH on a broken sidecar recovers url/title from the html header instead of nulling them", async () => {
  const { app, archiveDir, store } = await setup();
  const { id } = await (await upload(app)).json();
  const dir = join(archiveDir, store.get(id).relDir);
  await writeFile(join(dir, `${id}.json`), "{ broken");
  const patched = await (await app.request(`/api/items/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ memo: "x" }) })).json();
  assert.equal(patched.status, "ok");
  assert.equal(patched.url, "https://h.example/");
  assert.equal(patched.title, "Title");
  assert.equal(patched.memo, "x");
});

test("POST /api/singlefile opens the openUrl when openAfterSave is true", async () => {
  const { app, openInBrowser } = await setup({ openAfterSave: true });
  const res = await upload(app);
  const body = await res.json();
  assert.equal(openInBrowser.calls.length, 1);
  assert.equal(openInBrowser.calls[0], body.openUrl);
});

test("POST /api/singlefile does not open the URL when openAfterSave is false", async () => {
  const { app, openInBrowser } = await setup({ openAfterSave: false });
  await upload(app);
  assert.equal(openInBrowser.calls.length, 0);
});

test("POST /api/singlefile still returns 201 when openInBrowser resolves false", async (t) => {
  const errorMock = t.mock.method(console, "error", () => {});
  const failingOpen = () => Promise.resolve(false);
  failingOpen.calls = [];
  const { app } = await setup({ openAfterSave: true, openInBrowser: failingOpen });
  const res = await upload(app);
  assert.equal(res.status, 201);
  const body = await res.json();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errorMock.mock.calls.length, 1);
  assert.match(errorMock.mock.calls[0].arguments[0], new RegExp(body.openUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("an unreadable conflict copy shows memo null, and resolving it 400s without deleting anything", async () => {
  const { app, archiveDir, store } = await setup();
  const { id } = await (await upload(app)).json();
  const dir = join(archiveDir, store.get(id).relDir);
  const conflictName = `${id} (conflicted copy).json`;
  await writeFile(join(dir, conflictName), "{ broken");
  const detail = await (await app.request(`/api/items/${id}`)).json();
  assert.equal(detail.status, "conflict");
  assert.equal(detail.conflicts[0].memo, null);
  const res = await app.request(`/api/items/${id}/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ choose: `conflict:${conflictName}` }) });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "conflict copy is unreadable" });
  assert.deepEqual((await readdir(dir)).sort(), [`${id}.html`, `${id}.json`, conflictName].sort());
});

test("GET /api/settings reports values, sources and the config path", async () => {
  const { app, archiveDir, config } = await setup({ sources: { port: "env" } });
  const res = await app.request("/api/settings");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.configured, true);
  assert.equal(body.configPath, config.configPath);
  assert.deepEqual(body.values, { archiveDir, port: 8765, machineName: "mac", openAfterSave: false });
  assert.deepEqual(body.sources, { archiveDir: "file", port: "env", machineName: "file", openAfterSave: "default" });
});

test("PUT /api/settings applies valid values through the runtime", async () => {
  const { app, runtime } = await setup();
  const res = await putSettings(app, { archiveDir: "/new/archive", port: 9000, machineName: "box", openAfterSave: true });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.restartRequired, true);
  assert.equal(body.values.archiveDir, "/new/archive");
  assert.equal(body.values.machineName, "box");
  assert.deepEqual(runtime.calls, [{ archiveDir: "/new/archive", port: 9000, machineName: "box", openAfterSave: true }]);
});

test("PUT /api/settings expands a leading ~/ in archiveDir", async () => {
  const { app, runtime } = await setup();
  const res = await putSettings(app, { archiveDir: "~/Dropbox/WebArchive" });
  assert.equal(res.status, 200);
  assert.equal(runtime.calls[0].archiveDir, "/home/me/Dropbox/WebArchive");
});

test("PUT /api/settings rejects invalid values with 400 and does not apply", async () => {
  const { app, runtime } = await setup();
  for (const body of [
    { archiveDir: "relative/path" },
    { archiveDir: "" },
    { port: 0 },
    { port: "abc" },
    { machineName: "" },
    { machineName: "   " },
    { openAfterSave: "yes" }
  ]) {
    const res = await putSettings(app, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok((await res.json()).error);
  }
  assert.deepEqual(runtime.calls, []);
});

test("PUT /api/settings with a non-JSON body is 400", async () => {
  const { app } = await setup();
  const res = await app.request("/api/settings", { method: "PUT", body: "nope" });
  assert.equal(res.status, 400);
});

test("unconfigured server redirects / to /settings and refuses archive APIs with 503", async () => {
  const { app } = await setup({ configured: false });
  const root = await app.request("/");
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/settings");
  assert.equal((await app.request("/api/items")).status, 503);
  assert.equal((await app.request("/api/tags")).status, 503);
  assert.equal((await app.request("/api/items/01J7ZK4M3N5P6Q7R8S9T0V1W2X")).status, 503);
  assert.equal((await upload(app)).status, 503);
  const settings = await app.request("/settings");
  assert.equal(settings.status, 200);
  assert.match(await settings.text(), /<title>/);
  assert.equal((await app.request("/api/settings")).status, 200);
});

test("after the first PUT /api/settings the archive APIs become available", async () => {
  const { app, archiveDir } = await setup({ configured: false });
  const res = await putSettings(app, { archiveDir });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).configured, true);
  assert.equal((await app.request("/")).status, 200);
  assert.equal((await upload(app)).status, 201);
});

test("configured server serves /settings and / normally", async () => {
  const { app } = await setup();
  assert.equal((await app.request("/settings")).status, 200);
  assert.equal((await app.request("/")).status, 200);
});

test("static files and UI pages are served with Cache-Control: no-cache so browsers revalidate", async () => {
  const { app } = await setup();
  const { id } = await (await upload(app)).json();
  for (const path of ["/app.css", "/list.js", "/", "/settings", `/items/${id}`]) {
    const res = await app.request(path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("cache-control"), "no-cache", path);
  }
});

test("PUT /api/settings answers with a JSON error when applying the settings fails", async () => {
  const { app } = await setup();
  const failing = { apply: async () => { throw new Error("EACCES: permission denied, mkdir '/x/items'"); } };
  const config = { archiveDir: "/old", configured: true, dataDir: "/d", port: 8765, machineName: "mac", openAfterSave: false, configPath: "/c.json", sources: { archiveDir: "file", dataDir: "default", port: "default", machineName: "file", openAfterSave: "default" } };
  const store = new Store(":memory:");
  const broken = withDefaultHost(createApp({ config, store, runtime: failing }), "127.0.0.1:8765");
  const res = await putSettings(broken, { archiveDir: "/x" });
  assert.equal(res.status, 500);
  assert.equal(res.headers.get("content-type").split(";")[0], "application/json");
  assert.match((await res.json()).error, /EACCES/);
  void app;
});

test("GET /api/settings exposes the last startup/apply error", async () => {
  const { app, config } = await setup();
  config.lastError = "EACCES: permission denied";
  const body = await (await app.request("/api/settings")).json();
  assert.equal(body.lastError, "EACCES: permission denied");
});
