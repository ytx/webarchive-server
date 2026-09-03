import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { saveConfig as realSaveConfig, parsePort } from "./config.js";
import { rebuildIndex } from "./scanner.js";
import { startWatcher } from "./watcher.js";

// Owns the mutable runtime state derived from the config: the archive index
// and the filesystem watcher. `config` is mutated in place so that consumers
// holding a reference (the HTTP app) always see the current values.
export function createRuntime({ config, store, saveConfig = realSaveConfig, watcherOptions = {}, onError = (error) => console.error(error) }) {
  let watcher = null;

  // Bring the index and watcher up for the given archive. The directory is
  // created (and thereby checked for access) before the current watcher is
  // touched, so an unusable target fails without disturbing the running one.
  async function bringUp({ archiveDir, machineName }) {
    await mkdir(join(archiveDir, "items"), { recursive: true });
    const previous = watcher;
    watcher = null;
    if (previous) {
      await previous.close();
    }
    const count = await rebuildIndex({ archiveDir, machineName, store });
    watcher = startWatcher({ archiveDir, machineName, store, ...watcherOptions });
    return count;
  }

  return {
    config,
    async start() {
      if (!config.configured) {
        return 0;
      }
      try {
        const count = await bringUp(config);
        config.lastError = null;
        return count;
      } catch (error) {
        // Stay up in the unconfigured state so the settings page can show the
        // problem and accept a fix, instead of crash-looping under launchd.
        config.configured = false;
        config.lastError = error.message;
        onError(error);
        return 0;
      }
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
      const next = { archiveDir: values.archiveDir ?? config.archiveDir, machineName: values.machineName ?? config.machineName };
      const archiveChanged =
        Boolean(next.archiveDir) &&
        (!config.configured || next.archiveDir !== config.archiveDir || next.machineName !== config.machineName);
      if (archiveChanged) {
        try {
          await bringUp(next);
        } catch (error) {
          if (config.configured && !watcher) {
            await bringUp(config).catch(onError);
          }
          throw error;
        }
      }
      await saveConfig(config.configPath, values);

      const restartRequired = values.port !== undefined && values.port !== config.port;
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
      config.lastError = null;
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
