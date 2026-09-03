import { readFileSync, existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

export function loadConfig({ env = process.env, configFile = env.WEBARCHIVE_CONFIG ?? "config.json" } = {}) {
  const fromFile = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {};
  const archiveDir = env.ARCHIVE_DIR ?? fromFile.archiveDir;
  if (!archiveDir) {
    throw new Error("ARCHIVE_DIR is required (env ARCHIVE_DIR or config.json archiveDir)");
  }
  return {
    archiveDir: resolve(archiveDir),
    dataDir: resolve(env.DATA_DIR ?? fromFile.dataDir ?? join(homedir(), ".local", "share", "webarchive")),
    port: Number(env.PORT ?? fromFile.port ?? 8765),
    machineName: env.MACHINE_NAME ?? fromFile.machineName ?? hostname()
  };
}
