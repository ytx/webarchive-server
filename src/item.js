import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { classifyFile, normalizeTags, parseHtmlMeta, readSidecar, writeSidecarAtomic, sidecarDefaults } from "./sidecar.js";

export async function readItem({ archiveDir, machineName }, relDir, id) {
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
    const meta = parseHtmlMeta(await readFile(join(dir, `${id}.html`), "utf8"));
    sidecar = sidecarDefaults({ id, url: meta.url, title: meta.title, savedAt: meta.savedAt, savedOn: machineName });
    await writeSidecarAtomic(jsonPath, sidecar);
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
