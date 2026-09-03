import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { classifyFile, normalizeTags, parseHtmlMeta, readSidecar, writeSidecarAtomic, sidecarDefaults } from "./sidecar.js";

// An html file can arrive (via Dropbox sync) before its sidecar json. Only
// generate a sidecar for such an html-only item once it has sat untouched
// for a while (used by the startup scan); a fresh html-only file is left as
// merely pending. The watcher path always calls with the default
// createSidecar: false, so it never fabricates a sidecar for a json that is
// simply still in flight from another machine.
export const SIDECAR_GENERATION_MIN_AGE_MS = 5 * 60 * 1000;

export async function readItem({ archiveDir, machineName }, relDir, id, { createSidecar = false } = {}) {
  const dir = join(archiveDir, relDir);
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const files = names.map((name) => ({ name, ...classifyFile(name) })).filter((file) => file.id === id);
  const hasHtml = files.some((file) => file.kind === "html");
  const hasJson = files.some((file) => file.kind === "json");
  const conflictFiles = files.filter((file) => file.kind === "conflict").map((file) => file.name).sort();
  if (!hasHtml && !hasJson && conflictFiles.length === 0) {
    return null;
  }
  const jsonPath = join(dir, `${id}.json`);
  const base = { id, relDir, hasHtml, conflictFiles, url: null, title: null, memo: "", tags: [], savedAt: null, savedOn: null, updatedAt: null };
  let sidecar;
  if (hasJson) {
    try {
      sidecar = await readSidecar(jsonPath);
    } catch {
      return { ...base, status: "broken" };
    }
  } else if (hasHtml) {
    const htmlPath = join(dir, `${id}.html`);
    const meta = parseHtmlMeta(await readFile(htmlPath, "utf8"));
    let generate = false;
    if (createSidecar) {
      const stats = await stat(htmlPath);
      generate = Date.now() - stats.mtimeMs >= SIDECAR_GENERATION_MIN_AGE_MS;
    }
    if (generate) {
      sidecar = sidecarDefaults({ id, url: meta.url, title: meta.title, savedAt: meta.savedAt, savedOn: machineName });
      await writeSidecarAtomic(jsonPath, sidecar);
    } else {
      return {
        ...base,
        url: meta.url ?? null,
        title: meta.title ?? null,
        savedAt: meta.savedAt ?? null,
        status: conflictFiles.length > 0 ? "conflict" : "pending"
      };
    }
  } else {
    return { ...base, status: "conflict" };
  }
  let status = "ok";
  if (conflictFiles.length > 0) {
    status = "conflict";
  } else if (!hasHtml) {
    status = "pending";
  }
  return {
    ...base,
    url: sidecar.url ?? null,
    title: sidecar.title ?? null,
    memo: typeof sidecar.memo === "string" ? sidecar.memo : "",
    tags: normalizeTags(sidecar.tags),
    savedAt: sidecar.savedAt ?? null,
    savedOn: sidecar.savedOn ?? null,
    updatedAt: sidecar.updatedAt ?? null,
    status
  };
}
