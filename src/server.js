#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { createRuntime } from "./runtime.js";
import { createApp } from "./app.js";
import { openInBrowser } from "./open-in-browser.js";
import { createThumbnailer, findBrowser } from "./thumbnail.js";
import { readItem } from "./item.js";

const config = loadConfig();
if (!config.configured && existsSync("config.json") && resolve("config.json") !== config.configPath) {
  console.warn(`config.json in the current directory is no longer read; move it to ${config.configPath}`);
}
await mkdir(config.dataDir, { recursive: true });
const store = new Store(join(config.dataDir, "index.sqlite"));
const thumbnailer = createThumbnailer({
  get archiveDir() { return config.archiveDir; },
  get enabled() { return config.thumbnails; },
  get browser() { return findBrowser({ configured: config.browserPath }); },
  readItem: (relDir, id) => readItem({ archiveDir: config.archiveDir, machineName: config.machineName }, relDir, id),
  store
});
const runtime = createRuntime({ config, store, thumbnailer });
const count = await runtime.start();
if (config.configured) {
  console.log(`indexed ${count} items from ${config.archiveDir}`);
} else {
  console.log(`no archive directory configured yet (settings file: ${config.configPath})`);
}
const app = createApp({ config, store, runtime, thumbnailer });
serve({ fetch: app.fetch, hostname: "127.0.0.1", port: config.port }, () => {
  const base = `http://127.0.0.1:${config.port}`;
  console.log(`webarchive listening on ${base}/ (${config.machineName})`);
  console.log(`open after save: ${config.openAfterSave ? "on" : "off"}`);
  console.log(`thumbnails: ${config.thumbnails ? (thumbnailer.browser ? `on (${thumbnailer.browser}, ${thumbnailer.pending} queued)` : "on, but no browser found") : "off"}`);
  if (!config.configured) {
    console.log(`opening ${base}/settings for first-time setup`);
    openInBrowser(`${base}/settings`).catch(() => {});
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await runtime.close();
    store.close();
    process.exit(0);
  });
}
