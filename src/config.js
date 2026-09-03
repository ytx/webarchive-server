import { readFileSync, existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

export const FILE_KEYS = ["archiveDir", "dataDir", "port", "machineName", "openAfterSave"];
const ENV_KEYS = { archiveDir: "ARCHIVE_DIR", dataDir: "DATA_DIR", port: "PORT", machineName: "MACHINE_NAME", openAfterSave: "OPEN_AFTER_SAVE" };

export function defaultConfigPath({ env = process.env, home = homedir() } = {}) {
  const base = env.XDG_CONFIG_HOME || join(home, ".config");
  return join(base, "webarchive", "config.json");
}

function parseBoolean(raw) {
  return typeof raw === "string" ? !["false", "0", "no", "off"].includes(raw.toLowerCase()) : Boolean(raw);
}

export function parsePort(raw) {
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

export function loadConfig({ env = process.env, home = homedir(), configFile = env.WEBARCHIVE_CONFIG ?? defaultConfigPath({ env, home }) } = {}) {
  const fromFile = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {};
  const sources = {};
  const pick = (key) => {
    if (env[ENV_KEYS[key]] !== undefined) {
      sources[key] = "env";
      return env[ENV_KEYS[key]];
    }
    if (fromFile[key] !== undefined) {
      sources[key] = "file";
      return fromFile[key];
    }
    sources[key] = "default";
    return undefined;
  };
  const archiveDir = pick("archiveDir");
  const dataDir = pick("dataDir") ?? join(home, ".local", "share", "webarchive");
  const port = parsePort(pick("port") ?? 8765);
  const machineName = pick("machineName") ?? hostname();
  const openAfterSave = parseBoolean(pick("openAfterSave") ?? true);
  return {
    archiveDir: archiveDir ? resolve(archiveDir) : null,
    configured: Boolean(archiveDir),
    dataDir: resolve(dataDir),
    port,
    machineName,
    openAfterSave,
    configPath: configFile,
    sources
  };
}

export async function saveConfig(configFile, values) {
  let existing = {};
  try {
    existing = JSON.parse(await readFile(configFile, "utf8"));
  } catch {
    // no file yet, or unparsable: start fresh
  }
  const next = { ...existing };
  for (const key of FILE_KEYS) {
    if (values[key] !== undefined) {
      next[key] = values[key];
    }
  }
  await mkdir(resolve(configFile, ".."), { recursive: true });
  const tmp = `${configFile}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2) + "\n");
  await rename(tmp, configFile);
  return next;
}
