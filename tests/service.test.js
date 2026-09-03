import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LABEL, launchdPlist, schtasksCommand, installService, uninstallService, serviceStatus } from "../src/service.js";

const SERVER = "/opt/webarchive/src/server.js";
const NODE = "/usr/local/bin/node";

function fakeExec(results = {}) {
  const calls = [];
  const fn = async (command, args) => {
    calls.push([command, ...args]);
    const key = `${command} ${args.join(" ")}`;
    const hit = Object.entries(results).find(([prefix]) => key.startsWith(prefix));
    return hit ? hit[1] : { code: 0, stdout: "", stderr: "" };
  };
  fn.calls = calls;
  return fn;
}

test("launchdPlist embeds node, the server script, logs, and selected env vars", () => {
  const xml = launchdPlist({ node: NODE, server: SERVER, logDir: "/home/me/Library/Logs/webarchive", env: { ARCHIVE_DIR: "/a", WEBARCHIVE_CONFIG: "/c", PATH: "/ignored", HOME: "/ignored" } });
  assert.match(xml, /<key>Label<\/key>\s*<string>io\.github\.ytx\.webarchive<\/string>/);
  assert.match(xml, new RegExp(`<string>${NODE}</string>\\s*<string>--disable-warning=ExperimentalWarning</string>\\s*<string>${SERVER}</string>`));
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(xml, /<string>\/home\/me\/Library\/Logs\/webarchive\/stdout\.log<\/string>/);
  assert.match(xml, /<key>ARCHIVE_DIR<\/key>\s*<string>\/a<\/string>/);
  assert.match(xml, /<key>WEBARCHIVE_CONFIG<\/key>\s*<string>\/c<\/string>/);
  assert.doesNotMatch(xml, /HOME|\/ignored/);
});

test("launchdPlist escapes XML special characters in values", () => {
  const xml = launchdPlist({ node: NODE, server: SERVER, logDir: "/l", env: { ARCHIVE_DIR: "/a&b<c>" } });
  assert.match(xml, /<string>\/a&amp;b&lt;c&gt;<\/string>/);
});

test("launchdPlist omits EnvironmentVariables when nothing relevant is set", () => {
  const xml = launchdPlist({ node: NODE, server: SERVER, logDir: "/l", env: { PATH: "/x" } });
  assert.doesNotMatch(xml, /EnvironmentVariables/);
});

test("schtasksCommand quotes node and the server path", () => {
  const args = schtasksCommand({ node: "C:\\Program Files\\nodejs\\node.exe", server: "C:\\wa\\src\\server.js" });
  assert.deepEqual(args, ["/Create", "/TN", "webarchive", "/SC", "ONLOGON", "/RL", "LIMITED", "/F", "/TR", "\"C:\\Program Files\\nodejs\\node.exe\" --disable-warning=ExperimentalWarning \"C:\\wa\\src\\server.js\""]);
});

test("installService on darwin writes the plist, creates the log dir and bootstraps it", async () => {
  const home = await mkdtemp(join(tmpdir(), "wa-home-"));
  const exec = fakeExec({ "launchctl print": { code: 113, stdout: "", stderr: "" } });
  const result = await installService({ platform: "darwin", home, uid: 501, node: NODE, server: SERVER, env: {}, exec });
  const plist = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
  assert.equal(result.path, plist);
  assert.match(await readFile(plist, "utf8"), /<plist version="1.0">/);
  assert.ok((await stat(join(home, "Library", "Logs", "webarchive"))).isDirectory());
  assert.deepEqual(exec.calls, [
    ["launchctl", "bootout", `gui/501/${LABEL}`],
    ["launchctl", "print", `gui/501/${LABEL}`],
    ["launchctl", "bootstrap", "gui/501", plist]
  ]);
});

test("installService on darwin fails when bootstrap fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "wa-home-"));
  const exec = fakeExec({ "launchctl print": { code: 113, stdout: "", stderr: "" }, "launchctl bootstrap": { code: 5, stdout: "", stderr: "Input/output error" } });
  await assert.rejects(
    installService({ platform: "darwin", home, uid: 501, node: NODE, server: SERVER, env: {}, exec, sleep: async () => {} }),
    /launchctl bootstrap failed.*Input\/output error/
  );
});

test("uninstallService on darwin boots out and removes the plist", async () => {
  const home = await mkdtemp(join(tmpdir(), "wa-home-"));
  const plist = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
  await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
  await writeFile(plist, "x");
  const exec = fakeExec();
  const result = await uninstallService({ platform: "darwin", home, uid: 501, exec });
  assert.equal(result.removed, true);
  assert.deepEqual(exec.calls, [["launchctl", "bootout", `gui/501/${LABEL}`]]);
  await assert.rejects(stat(plist));
});

test("uninstallService on darwin is a no-op when nothing is installed", async () => {
  const home = await mkdtemp(join(tmpdir(), "wa-home-"));
  const exec = fakeExec({ "launchctl bootout": { code: 3, stdout: "", stderr: "No such process" } });
  const result = await uninstallService({ platform: "darwin", home, uid: 501, exec });
  assert.equal(result.removed, false);
});

test("serviceStatus on darwin reports installed and running state", async () => {
  const home = await mkdtemp(join(tmpdir(), "wa-home-"));
  const notInstalled = await serviceStatus({ platform: "darwin", home, uid: 501, exec: fakeExec({ "launchctl print": { code: 113, stdout: "", stderr: "" } }) });
  assert.deepEqual(notInstalled, { installed: false, running: false, path: join(home, "Library", "LaunchAgents", `${LABEL}.plist`) });
  await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
  await writeFile(join(home, "Library", "LaunchAgents", `${LABEL}.plist`), "x");
  const running = await serviceStatus({ platform: "darwin", home, uid: 501, exec: fakeExec({ "launchctl print": { code: 0, stdout: "state = running\n\tpid = 42", stderr: "" } }) });
  assert.deepEqual(running, { installed: true, running: true, path: join(home, "Library", "LaunchAgents", `${LABEL}.plist`) });
});

test("installService on win32 creates the task and runs it", async () => {
  const exec = fakeExec();
  const result = await installService({ platform: "win32", node: "C:\\n\\node.exe", server: "C:\\wa\\src\\server.js", env: {}, exec });
  assert.equal(result.path, "webarchive");
  assert.equal(exec.calls.length, 2);
  assert.deepEqual(exec.calls[0].slice(0, 4), ["schtasks", "/Create", "/TN", "webarchive"]);
  assert.deepEqual(exec.calls[1], ["schtasks", "/Run", "/TN", "webarchive"]);
});

test("uninstallService and serviceStatus on win32 use schtasks", async () => {
  const exec = fakeExec();
  await uninstallService({ platform: "win32", exec });
  assert.deepEqual(exec.calls, [["schtasks", "/Delete", "/TN", "webarchive", "/F"]]);
  const status = await serviceStatus({ platform: "win32", exec: fakeExec({ "schtasks /Query": { code: 0, stdout: "webarchive  N/A  Running", stderr: "" } }) });
  assert.deepEqual(status, { installed: true, running: true, path: "webarchive" });
  const missing = await serviceStatus({ platform: "win32", exec: fakeExec({ "schtasks /Query": { code: 1, stdout: "", stderr: "ERROR: not found" } }) });
  assert.deepEqual(missing, { installed: false, running: false, path: "webarchive" });
});

test("service functions reject unsupported platforms", async () => {
  await assert.rejects(installService({ platform: "linux", node: NODE, server: SERVER, env: {}, exec: fakeExec() }), /not supported on linux/);
  await assert.rejects(uninstallService({ platform: "linux", exec: fakeExec() }), /not supported on linux/);
  await assert.rejects(serviceStatus({ platform: "linux", exec: fakeExec() }), /not supported on linux/);
});

test("installService on darwin waits for the previous registration to go away before bootstrapping", async () => {
  const home = await mkdtemp(join(tmpdir(), "wa-home-"));
  let prints = 0;
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "print") {
      prints++;
      return prints <= 2 ? { code: 0, stdout: "state = running", stderr: "" } : { code: 113, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const sleeps = [];
  await installService({ platform: "darwin", home, uid: 501, node: NODE, server: SERVER, env: {}, exec, sleep: async (ms) => sleeps.push(ms) });
  const order = calls.map((c) => c[1]);
  assert.deepEqual(order, ["bootout", "print", "print", "print", "bootstrap"]);
  assert.equal(sleeps.length, 2, "slept between checks while still loaded");
});

test("installService on darwin retries a bootstrap that fails with EIO (5) and succeeds later", async () => {
  const home = await mkdtemp(join(tmpdir(), "wa-home-"));
  let bootstraps = 0;
  const exec = async (command, args) => {
    if (args[0] === "print") {
      return { code: 113, stdout: "", stderr: "" };
    }
    if (args[0] === "bootstrap") {
      bootstraps++;
      return bootstraps < 3 ? { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" } : { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  await installService({ platform: "darwin", home, uid: 501, node: NODE, server: SERVER, env: {}, exec, sleep: async () => {} });
  assert.equal(bootstraps, 3);
});

test("installService on darwin gives up after repeated bootstrap failures", async () => {
  const home = await mkdtemp(join(tmpdir(), "wa-home-"));
  const exec = async (command, args) => (args[0] === "print" ? { code: 113, stdout: "", stderr: "" } : args[0] === "bootstrap" ? { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" } : { code: 0, stdout: "", stderr: "" });
  await assert.rejects(installService({ platform: "darwin", home, uid: 501, node: NODE, server: SERVER, env: {}, exec, sleep: async () => {} }), /launchctl bootstrap failed \(5\)/);
});
