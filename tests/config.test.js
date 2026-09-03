import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { loadConfig, saveConfig, defaultConfigPath } from "../src/config.js";

test("loadConfig reads env with defaults", () => {
  const config = loadConfig({ env: { ARCHIVE_DIR: "/tmp/a" } });
  assert.equal(config.archiveDir, "/tmp/a");
  assert.equal(config.port, 8765);
  assert.ok(config.dataDir.endsWith("webarchive"));
  assert.ok(config.machineName.length > 0);
});

test("loadConfig without ARCHIVE_DIR yields an unconfigured state instead of throwing", () => {
  const config = loadConfig({ env: {}, configFile: "/nonexistent/config.json" });
  assert.equal(config.archiveDir, null);
  assert.equal(config.configured, false);
  assert.equal(config.port, 8765);
});

test("defaultConfigPath prefers XDG_CONFIG_HOME, then ~/.config", () => {
  assert.equal(defaultConfigPath({ env: { XDG_CONFIG_HOME: "/xdg" }, home: "/home/me" }), join("/xdg", "webarchive", "config.json"));
  assert.equal(defaultConfigPath({ env: {}, home: "/home/me" }), join("/home/me", ".config", "webarchive", "config.json"));
});

test("loadConfig reads the default config path and reports it", async () => {
  const home = await mkdtemp(join(tmpdir(), "wa-home-"));
  const file = join(home, ".config", "webarchive", "config.json");
  await mkdir(join(home, ".config", "webarchive"), { recursive: true });
  await writeFile(file, JSON.stringify({ archiveDir: "/from/default" }));
  const config = loadConfig({ env: {}, home });
  assert.equal(config.archiveDir, "/from/default");
  assert.equal(config.configPath, file);
  assert.equal(config.configured, true);
});

test("WEBARCHIVE_CONFIG overrides the default config path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wa-"));
  const file = join(dir, "custom.json");
  await writeFile(file, JSON.stringify({ archiveDir: "/from/custom" }));
  const config = loadConfig({ env: { WEBARCHIVE_CONFIG: file }, home: "/nonexistent" });
  assert.equal(config.archiveDir, "/from/custom");
  assert.equal(config.configPath, file);
});

test("loadConfig reports the source of each value", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wa-"));
  const file = join(dir, "config.json");
  await writeFile(file, JSON.stringify({ archiveDir: "/from/file", port: 9000 }));
  const config = loadConfig({ env: { PORT: "9100" }, configFile: file });
  assert.deepEqual(config.sources, { archiveDir: "file", dataDir: "default", port: "env", machineName: "default", openAfterSave: "default" });
});

test("saveConfig writes the file-managed values, creating the directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wa-"));
  const file = join(dir, "nested", "config.json");
  await saveConfig(file, { archiveDir: "/a", port: 8800, machineName: "box", openAfterSave: false });
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { archiveDir: "/a", port: 8800, machineName: "box", openAfterSave: false });
});

test("saveConfig preserves unrelated keys already in the file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wa-"));
  const file = join(dir, "config.json");
  await writeFile(file, JSON.stringify({ archiveDir: "/old", dataDir: "/keep" }));
  await saveConfig(file, { archiveDir: "/new" });
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { archiveDir: "/new", dataDir: "/keep" });
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
