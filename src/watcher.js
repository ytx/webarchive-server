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
