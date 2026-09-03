import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ULID_PREFIX_RE = /^[0-9A-HJKMNP-TV-Z]{26}/;

export function classifyFile(name) {
  const tmp = /^\.([0-9A-HJKMNP-TV-Z]{26})\.(?:html|json)\.tmp/.exec(name);
  if (tmp) {
    return { kind: "tmp", id: tmp[1] };
  }
  const id = ULID_PREFIX_RE.exec(name)?.[0];
  if (!id) {
    return { kind: "other", id: null };
  }
  if (name === `${id}.html`) {
    return { kind: "html", id };
  }
  if (name === `${id}.json`) {
    return { kind: "json", id };
  }
  if (name.endsWith(".json")) {
    return { kind: "conflict", id };
  }
  return { kind: "other", id: null };
}

export function normalizeTags(tags) {
  const seen = new Set();
  const result = [];
  for (const raw of Array.isArray(tags) ? tags : []) {
    const tag = String(raw).trim().toLowerCase();
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      result.push(tag);
    }
  }
  return result;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", "#39": "'" };

function decodeEntities(text) {
  return text.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return ENTITIES[entity] ?? match;
  });
}

export function parseHtmlMeta(html) {
  const head = html.slice(0, 64 * 1024);
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim() || null : null;
  const comment = /<!--\s*Page saved with SingleFile([\s\S]*?)-->/i.exec(head);
  let url = null;
  let savedAt = null;
  if (comment) {
    url = /^\s*url:\s*(\S+)/m.exec(comment[1])?.[1] ?? null;
    const dateText = /^\s*saved date:\s*(.+?)\s*$/m.exec(comment[1])?.[1];
    if (dateText) {
      const date = new Date(dateText);
      savedAt = Number.isNaN(date.getTime()) ? null : toIsoWithOffset(date);
    }
  }
  return { title, url, savedAt };
}

export function toIsoWithOffset(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const pad = (n) => String(Math.trunc(Math.abs(n))).padStart(2, "0");
  const local = new Date(date.getTime() + offsetMinutes * 60000);
  return local.toISOString().replace(/\.\d{3}Z$/, "") + sign + pad(offsetMinutes / 60) + ":" + pad(offsetMinutes % 60);
}

export function sidecarDefaults({ id, url, title, savedAt, savedOn }) {
  return {
    id,
    url: url ?? null,
    title: title ?? null,
    savedAt: savedAt ?? toIsoWithOffset(),
    savedOn: savedOn ?? null,
    memo: "",
    tags: [],
    updatedAt: savedAt ?? toIsoWithOffset()
  };
}

export async function readSidecar(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

// Write via a temp file in the same directory, then rename, so Dropbox never
// syncs a partially written file. Used for both the sidecar json and (by
// ingest.js) the saved html.
export async function writeFileAtomic(path, data) {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${randomBytes(4).toString("hex")}`);
  try {
    await writeFile(tmp, data);
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

export async function writeSidecarAtomic(path, data) {
  await writeFileAtomic(path, JSON.stringify(data, null, 2) + "\n");
}

// Reconstruct sidecar defaults from the saved html's own header/title when
// the real sidecar json is missing or unreadable (broken), so recoverable
// metadata (url/title/savedAt) isn't discarded in favor of nulls.
export async function sidecarFromHtml(archiveDir, relDir, id, machineName) {
  try {
    const meta = parseHtmlMeta(await readFile(join(archiveDir, relDir, `${id}.html`), "utf8"));
    return sidecarDefaults({ id, url: meta.url, title: meta.title, savedAt: meta.savedAt, savedOn: machineName });
  } catch {
    return sidecarDefaults({ id, savedOn: machineName });
  }
}
