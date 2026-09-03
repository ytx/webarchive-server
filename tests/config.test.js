import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

test("loadConfig reads env with defaults", () => {
  const config = loadConfig({ env: { ARCHIVE_DIR: "/tmp/a" } });
  assert.equal(config.archiveDir, "/tmp/a");
  assert.equal(config.port, 8765);
  assert.ok(config.dataDir.endsWith("webarchive"));
  assert.ok(config.machineName.length > 0);
});

test("loadConfig throws without ARCHIVE_DIR", () => {
  assert.throws(() => loadConfig({ env: {} }), /ARCHIVE_DIR is required/);
});

test("config file values are overridden by env", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wa-"));
  const file = join(dir, "config.json");
  await writeFile(file, JSON.stringify({ archiveDir: "/from/file", port: 9000, machineName: "filebox" }));
  const config = loadConfig({ env: { PORT: "9100" }, configFile: file });
  assert.equal(config.archiveDir, "/from/file");
  assert.equal(config.port, 9100);
  assert.equal(config.machineName, "filebox");
});
