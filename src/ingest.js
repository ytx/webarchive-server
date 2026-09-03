import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ulid } from "ulid";
import { parseHtmlMeta, sidecarDefaults, writeSidecarAtomic, toIsoWithOffset } from "./sidecar.js";
import { readItem } from "./item.js";

export async function ingest({ archiveDir, machineName, store }, { html, url, filename, now = new Date() }) {
  const id = ulid(now.getTime());
  const relDir = `items/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}`;
  const dir = join(archiveDir, relDir);
  await mkdir(dir, { recursive: true });
  const htmlPath = join(dir, `${id}.html`);
  const jsonPath = join(dir, `${id}.json`);
  const text = Buffer.isBuffer(html) ? html.toString("utf8") : String(html);
  const meta = parseHtmlMeta(text);
  const title = meta.title ?? (filename ? filename.replace(/\.[^.]+$/, "") : null);
  const sidecar = sidecarDefaults({ id, url: url || meta.url, title, savedAt: toIsoWithOffset(now), savedOn: machineName });
  try {
    await writeFile(htmlPath, html);
    await writeSidecarAtomic(jsonPath, sidecar);
  } catch (error) {
    await unlink(htmlPath).catch(() => {});
    await unlink(jsonPath).catch(() => {});
    throw error;
  }
  const item = await readItem({ archiveDir, machineName }, relDir, id);
  store.upsert(item);
  return item;
}
