import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { saveConfig as realSaveConfig, parsePort } from "./config.js";
import { rebuildIndex } from "./scanner.js";
import { startWatcher } from "./watcher.js";

// Owns the mutable runtime state derived from the config: the archive index
// and the filesystem watcher. `config` is mutated in place so that consumers
// holding a reference (the HTTP app) always see the current values.
export function createRuntime({ config, store, saveConfig = realSaveConfig, watcherOptions = {} }) {
  let watcher = null;

  async function bringUp() {
    if (watcher) {
      await watcher.close();
      watcher = null;
    }
    await mkdir(join(config.archiveDir, "items"), { recursive: true });
    const count = await rebuildIndex({ archiveDir: config.archiveDir, machineName: config.machineName, store });
    watcher = startWatcher({ archiveDir: config.archiveDir, machineName: config.machineName, store, ...watcherOptions });
    return count;
  }

  return {
    config,
    async start() {
      if (!config.configured) {
        return 0;
      }
      return bringUp();
    },
    async apply(patch) {
      const values = {};
      for (const key of ["archiveDir", "port", "machineName", "openAfterSave"]) {
        if (patch[key] !== undefined && config.sources[key] !== "env") {
          values[key] = patch[key];
        }
      }
      if (values.archiveDir !== undefined) {
        values.archiveDir = resolve(values.archiveDir);
      }
      if (values.port !== undefined) {
        values.port = parsePort(values.port);
      }
      await saveConfig(config.configPath, values);

      const restartRequired = values.port !== undefined && values.port !== config.port;
      const archiveChanged =
        (values.archiveDir !== undefined && values.archiveDir !== config.archiveDir) ||
        (values.machineName !== undefined && values.machineName !== config.machineName);
      for (const key of ["archiveDir", "machineName", "openAfterSave"]) {
        if (values[key] !== undefined) {
          config[key] = values[key];
          config.sources[key] = "file";
        }
      }
      if (values.port !== undefined) {
        config.sources.port = "file";
      }
      config.configured = Boolean(config.archiveDir);
      if (config.configured && archiveChanged) {
        await bringUp();
      }
      return { restartRequired };
    },
    async close() {
      if (watcher) {
        await watcher.close();
        watcher = null;
      }
    }
  };
}
