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

test("loadConfig rejects an out-of-range or non-integer PORT", () => {
  assert.throws(() => loadConfig({ env: { ARCHIVE_DIR: "/tmp/a", PORT: "0" } }), /PORT must be an integer between 1 and 65535/);
  assert.throws(() => loadConfig({ env: { ARCHIVE_DIR: "/tmp/a", PORT: "70000" } }), /PORT must be an integer between 1 and 65535/);
  assert.throws(() => loadConfig({ env: { ARCHIVE_DIR: "/tmp/a", PORT: "8765.5" } }), /PORT must be an integer between 1 and 65535/);
  assert.throws(() => loadConfig({ env: { ARCHIVE_DIR: "/tmp/a", PORT: "abc" } }), /PORT must be an integer between 1 and 65535/);
});

test("loadConfig defaults openAfterSave to true", () => {
  const config = loadConfig({ env: { ARCHIVE_DIR: "/tmp/a" } });
  assert.equal(config.openAfterSave, true);
});

test("OPEN_AFTER_SAVE=false disables openAfterSave", () => {
  const config = loadConfig({ env: { ARCHIVE_DIR: "/tmp/a", OPEN_AFTER_SAVE: "false" } });
  assert.equal(config.openAfterSave, false);
});

test("OPEN_AFTER_SAVE accepts 0, no, off case-insensitively as false", () => {
  for (const value of ["0", "no", "off", "FALSE", "Off", "NO"]) {
    const config = loadConfig({ env: { ARCHIVE_DIR: "/tmp/a", OPEN_AFTER_SAVE: value } });
    assert.equal(config.openAfterSave, false, `expected ${value} to disable openAfterSave`);
  }
});

test("config.json openAfterSave: false disables it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wa-"));
  const file = join(dir, "config.json");
  await writeFile(file, JSON.stringify({ archiveDir: "/from/file", openAfterSave: false }));
  const config = loadConfig({ env: {}, configFile: file });
  assert.equal(config.openAfterSave, false);
});

test("env OPEN_AFTER_SAVE overrides config.json openAfterSave: false", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wa-"));
  const file = join(dir, "config.json");
  await writeFile(file, JSON.stringify({ archiveDir: "/from/file", openAfterSave: false }));
  const config = loadConfig({ env: { OPEN_AFTER_SAVE: "true" }, configFile: file });
  assert.equal(config.openAfterSave, true);
});
