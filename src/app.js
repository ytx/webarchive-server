import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFile, readdir, unlink } from "node:fs/promises";
import { join, dirname, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parsePort } from "./config.js";
import { ingest } from "./ingest.js";
import { readItem } from "./item.js";
import { ULID_RE, classifyFile, normalizeTags, readSidecar, writeSidecarAtomic, sidecarDefaults, sidecarFromHtml, toIsoWithOffset } from "./sidecar.js";
import { openInBrowser as realOpenInBrowser } from "./open-in-browser.js";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const SETTINGS_KEYS = ["archiveDir", "port", "machineName", "openAfterSave"];

// Validate a settings PUT body. Returns { values } or { error }.
export function parseSettings(body, { home = homedir() } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "body must be a JSON object" };
  }
  const values = {};
  if (body.archiveDir !== undefined) {
    if (typeof body.archiveDir !== "string" || body.archiveDir.trim() === "") {
      return { error: "archiveDir must be a non-empty path" };
    }
    let dir = body.archiveDir.trim();
    if (dir === "~" || dir.startsWith("~/")) {
      dir = join(home, dir.slice(1));
    }
    if (!isAbsolute(dir)) {
      return { error: "archiveDir must be an absolute path" };
    }
    values.archiveDir = dir;
  }
  if (body.port !== undefined) {
    try {
      values.port = parsePort(body.port);
    } catch (error) {
      return { error: error.message };
    }
  }
  if (body.machineName !== undefined) {
    if (typeof body.machineName !== "string" || body.machineName.trim() === "") {
      return { error: "machineName must be a non-empty string" };
    }
    values.machineName = body.machineName.trim();
  }
  if (body.openAfterSave !== undefined) {
    if (typeof body.openAfterSave !== "boolean") {
      return { error: "openAfterSave must be a boolean" };
    }
    values.openAfterSave = body.openAfterSave;
  }
  return { values };
}

export function createApp({ config, store, openInBrowser = realOpenInBrowser, runtime, home = homedir() }) {
  const app = new Hono();
  // `config` is mutated in place by the runtime when settings change, so read
  // archiveDir/machineName through getters rather than copying them once.
  const ctx = {
    get archiveDir() {
      return config.archiveDir;
    },
    get machineName() {
      return config.machineName;
    },
    store
  };

  // DNS-rebinding guard: this server binds only to 127.0.0.1 but Node's http
  // server does not itself validate the Host header, so a page on the public
  // internet could still resolve a hostname to 127.0.0.1 and make same-origin
  // requests here. Reject anything whose Host doesn't name this loopback
  // server (including a request with no Host header at all).
  const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`, `[::1]:${config.port}`]);
  if (config.port === 80) {
    allowedHosts.add("127.0.0.1").add("localhost").add("[::1]");
  }
  app.use("*", async (c, next) => {
    const host = c.req.header("host");
    if (!host || !allowedHosts.has(host)) {
      return c.json({ error: "forbidden host" }, 403);
    }
    return next();
  });

  app.use("/api/*", cors({
    origin: (origin) => (origin && /^(chrome|moz)-extension:\/\//.test(origin) ? origin : ""),
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"]
  }));

  function settingsView() {
    const values = Object.fromEntries(SETTINGS_KEYS.map((key) => [key, config[key]]));
    const sources = Object.fromEntries(SETTINGS_KEYS.map((key) => [key, config.sources[key]]));
    return { configured: config.configured, configPath: config.configPath, values, sources };
  }

  app.get("/api/settings", (c) => c.json(settingsView()));

  app.put("/api/settings", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (body === null) {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const { values, error } = parseSettings(body, { home });
    if (error) {
      return c.json({ error }, 400);
    }
    const { restartRequired } = await runtime.apply(values);
    return c.json({ ...settingsView(), restartRequired });
  });

  app.get("/settings", async (c) => c.html(await readFile(join(PUBLIC_DIR, "settings.html"), "utf8")));

  // Everything below needs an archive directory. Until one is configured,
  // send the UI to the settings page and refuse the archive APIs.
  app.use("/api/*", async (c, next) => {
    if (!config.configured) {
      return c.json({ error: "not configured" }, 503);
    }
    return next();
  });
  const redirectUnlessConfigured = async (c, next) => (config.configured ? next() : c.redirect("/settings"));
  app.use("/", redirectUnlessConfigured);
  app.use("/items/*", redirectUnlessConfigured);

  app.post("/api/singlefile", async (c) => {
    // POST with multipart/form-data is a CORS-simple request, so the browser
    // sends it (and lets the response through to script) even without a
    // preflight or a matching Access-Control-Allow-Origin. Enforce the same
    // chrome/moz-extension origin restriction here explicitly; a request with
    // no Origin header at all (curl, the extension's background page) is
    // still allowed.
    const origin = c.req.header("origin");
    if (origin && !/^(chrome|moz)-extension:\/\//.test(origin)) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    const contentLength = Number(c.req.header("content-length") ?? 0);
    if (contentLength > MAX_UPLOAD_BYTES) {
      return c.json({ error: "payload too large" }, 413);
    }
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) {
      return c.json({ error: "multipart field 'file' is required" }, 400);
    }
    const html = Buffer.from(await file.arrayBuffer());
    const url = typeof body.url === "string" ? body.url : "";
    const item = await ingest(ctx, { html, url, filename: file.name });
    const openUrl = `http://127.0.0.1:${config.port}/items/${item.id}?new=1`;
    if (config.openAfterSave) {
      openInBrowser(openUrl)
        .then((ok) => {
          if (!ok) {
            console.error(`failed to open ${openUrl} in browser`);
          }
        })
        .catch(() => {});
    }
    return c.json({ id: item.id, openUrl }, 201);
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
      // The sidecar is missing or unparsable (status "broken"): recover the
      // url/title/savedAt from the saved html's own header rather than
      // discarding them as nulls, so a PATCH that only touches memo/tags
      // (e.g. from the repair form) doesn't wipe out recoverable metadata.
      sidecar = await sidecarFromHtml(config.archiveDir, item.relDir, item.id, config.machineName);
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
    const fresh = await refresh(item);
    if (!fresh) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(fresh);
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
      let chosen;
      try {
        chosen = await readSidecar(join(dir, file));
      } catch {
        return c.json({ error: "conflict copy is unreadable" }, 400);
      }
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
    const fresh = await refresh(item);
    if (!fresh) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(fresh);
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
  app.use("/*", serveStatic({ root: PUBLIC_DIR }));

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
