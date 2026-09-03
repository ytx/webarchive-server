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
  console.log(`open after save: ${config.openAfterSave ? "on" : "off"}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await watcher.close();
    store.close();
    process.exit(0);
  });
}
