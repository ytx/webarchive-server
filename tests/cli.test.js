import { test } from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../src/cli.js";

function harness({ install, uninstall, status } = {}) {
  const out = [];
  const err = [];
  const calls = [];
  const io = {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    startServer: async () => calls.push("start"),
    service: {
      install: install ?? (async (opts) => (calls.push(["install", opts]), { path: "/p.plist", logDir: "/logs" })),
      uninstall: uninstall ?? (async () => (calls.push("uninstall"), { removed: true, path: "/p.plist" })),
      status: status ?? (async () => (calls.push("status"), { installed: true, running: false, path: "/p.plist" }))
    }
  };
  return { io, out: () => out.join(""), err: () => err.join(""), calls };
}

test("no arguments starts the server", async () => {
  const { io, calls } = harness();
  assert.equal(await runCli([], io), 0);
  assert.deepEqual(calls, ["start"]);
});

test("service install calls install with the server script path and prints where it went", async () => {
  const { io, calls, out } = harness();
  assert.equal(await runCli(["service", "install"], io), 0);
  assert.equal(calls[0][0], "install");
  assert.match(calls[0][1].server, /src[\\/]server\.js$/);
  assert.match(out(), /\/p\.plist/);
  assert.match(out(), /\/logs/);
});

test("service uninstall and status print their result", async () => {
  const { io, out, calls } = harness();
  assert.equal(await runCli(["service", "uninstall"], io), 0);
  assert.equal(await runCli(["service", "status"], io), 0);
  assert.deepEqual(calls, ["uninstall", "status"]);
  assert.match(out(), /removed/);
  assert.match(out(), /installed: yes/);
  assert.match(out(), /running: no/);
});

test("service uninstall reports when nothing was installed", async () => {
  const { io, out } = harness({ uninstall: async () => ({ removed: false, path: "/p.plist" }) });
  assert.equal(await runCli(["service", "uninstall"], io), 0);
  assert.match(out(), /not installed/);
});

test("a failing service command prints the error to stderr and exits 1", async () => {
  const { io, err } = harness({ install: async () => { throw new Error("launchctl bootstrap failed"); } });
  assert.equal(await runCli(["service", "install"], io), 1);
  assert.match(err(), /launchctl bootstrap failed/);
});

test("unknown commands and bare service print usage and exit 1; help exits 0", async () => {
  const { io, err, out, calls } = harness();
  assert.equal(await runCli(["service"], io), 1);
  assert.equal(await runCli(["service", "dance"], io), 1);
  assert.equal(await runCli(["bogus"], io), 1);
  assert.match(err(), /Usage/);
  assert.equal(await runCli(["help"], io), 0);
  assert.equal(await runCli(["--help"], io), 0);
  assert.match(out(), /service install/);
  assert.deepEqual(calls, []);
});

test("the bin entry still runs when invoked through a symlink, as npm installs it", async () => {
  const { mkdtemp, symlink } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const dir = await mkdtemp(join(tmpdir(), "wa-bin-"));
  const link = join(dir, "webarchive");
  await symlink(resolve("src/cli.js"), link);
  const { stdout, code } = await new Promise((done) => {
    execFile(process.execPath, [link, "help"], (error, stdout) => done({ stdout, code: error?.code ?? 0 }));
  });
  assert.equal(code, 0);
  assert.match(stdout, /Usage:/);
});
