import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { classifyFile } from "./sidecar.js";
import { readItem } from "./item.js";

export async function scanArchive(archiveDir) {
  const root = join(archiveDir, "items");
  let entries;
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const seen = new Map();
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const { kind, id } = classifyFile(entry.name);
    if (kind === "other" || kind === "tmp") {
      continue;
    }
    const relDir = relative(archiveDir, entry.parentPath).split("\\").join("/");
    seen.set(`${relDir}/${id}`, { relDir, id });
  }
  return [...seen.values()];
}

export async function rebuildIndex({ archiveDir, machineName, store }) {
  const found = await scanArchive(archiveDir);
  store.clear();
  let count = 0;
  for (const { relDir, id } of found) {
    const item = await readItem({ archiveDir, machineName }, relDir, id, { createSidecar: true });
    if (item) {
      store.upsert(item);
      count++;
    }
  }
  return count;
}
