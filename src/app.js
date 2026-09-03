import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
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
  // public/ is created by Task 8; serveStatic logs to stderr at mount time if its
  // root is missing, so only mount it once the directory actually exists.
  if (existsSync(PUBLIC_DIR)) {
    app.use("/*", serveStatic({ root: "./public" }));
  }

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
