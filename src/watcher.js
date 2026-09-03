import { watch } from "chokidar";
import { basename, dirname, join, relative } from "node:path";
import { classifyFile } from "./sidecar.js";
import { readItem } from "./item.js";

export function startWatcher({ archiveDir, machineName, store, debounceMs = 300, onError = (e) => console.error(e) }) {
  const root = join(archiveDir, "items");
  const timers = new Map();
  // Per-item work is serialized: `inFlight` holds the one running readItem+store
  // update for a key, and `dirty` marks keys that got another event while that
  // read was in progress so we re-run once instead of racing two reads. Note
  // chokidar's awaitWriteFinish and this debounce stack, so end-to-end latency
  // for a single event is roughly 2×debounceMs.
  const inFlight = new Map();
  const dirty = new Set();
  let closed = false;

  function start(key, relDir, id) {
    const promise = readItem({ archiveDir, machineName }, relDir, id)
      .then((item) => {
        if (item) {
          store.upsert(item);
        } else {
          store.remove(id);
        }
      })
      .catch((error) => {
        onError(error);
      })
      .then(() => {
        inFlight.delete(key);
        if (!closed && dirty.delete(key)) {
          start(key, relDir, id);
        } else {
          dirty.delete(key);
        }
      });
    inFlight.set(key, promise);
  }

  function schedule(path) {
    if (closed) {
      return;
    }
    const { kind, id } = classifyFile(basename(path));
    if (kind === "other" || kind === "tmp") {
      return;
    }
    const relDir = relative(archiveDir, dirname(path)).split("\\").join("/");
    const key = `${relDir}/${id}`;
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      if (closed) {
        return;
      }
      if (inFlight.has(key)) {
        dirty.add(key);
        return;
      }
      start(key, relDir, id);
    }, debounceMs));
  }

  const watcher = watch(root, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: debounceMs, pollInterval: 50 } });
  watcher.on("add", schedule).on("change", schedule).on("unlink", schedule).on("error", onError);

  return {
    async close() {
      closed = true;
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
      dirty.clear();
      await watcher.close();
      await Promise.all([...inFlight.values()]);
    }
  };
}
