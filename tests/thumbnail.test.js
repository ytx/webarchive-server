import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findBrowser, captureThumbnail, browserArgs, createThumbnailer } from "../src/thumbnail.js";

function existsIn(paths) {
  return (path) => paths.includes(path);
}

test("findBrowser prefers an explicit path when it exists", () => {
  const found = findBrowser({ configured: "/opt/mybrowser", platform: "linux", env: {}, exists: existsIn(["/opt/mybrowser"]) });
  assert.equal(found, "/opt/mybrowser");
  assert.equal(findBrowser({ configured: "/opt/missing", platform: "linux", env: {}, exists: () => false }), null,
    "an explicit path that does not exist is an error, not a fallthrough to auto-detection");
});

test("findBrowser on darwin walks the known .app bundles", () => {
  const brave = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
  assert.equal(findBrowser({ platform: "darwin", env: {}, exists: existsIn([brave]) }), brave);
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  assert.equal(findBrowser({ platform: "darwin", env: {}, exists: existsIn([brave, chrome]) }), chrome, "Chrome wins over Brave");
  assert.equal(findBrowser({ platform: "darwin", env: {}, exists: () => false }), null);
});

test("findBrowser on win32 checks Program Files and LocalAppData, Edge included", () => {
  const env = { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" };
  const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  assert.equal(findBrowser({ platform: "win32", env, exists: existsIn([edge]) }), edge);
  const chrome = "C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
  assert.equal(findBrowser({ platform: "win32", env, exists: existsIn([edge, chrome]) }), chrome);
});

test("findBrowser on linux searches PATH for the known command names", () => {
  const env = { PATH: "/usr/local/bin:/usr/bin:/snap/bin" };
  assert.equal(findBrowser({ platform: "linux", env, exists: existsIn(["/snap/bin/chromium"]) }), "/snap/bin/chromium");
  assert.equal(findBrowser({ platform: "linux", env, exists: existsIn(["/snap/bin/chromium", "/usr/bin/google-chrome"]) }), "/usr/bin/google-chrome");
  assert.equal(findBrowser({ platform: "linux", env, exists: () => false }), null);
});

test("browserArgs isolates the profile, blocks the network and renders a scaled-down page", () => {
  const args = browserArgs({ profileDir: "/tmp/p", outPath: "/tmp/out.png", htmlPath: "/arc/items/2026/10/X.html" });
  assert.ok(args.includes("--headless=new"));
  assert.ok(args.includes("--user-data-dir=/tmp/p"));
  assert.ok(args.includes("--host-rules=MAP * ~NOTFOUND"));
  assert.ok(args.includes("--screenshot=/tmp/out.png"));
  assert.ok(args.includes("--window-size=1280,800"));
  assert.ok(args.includes("--no-first-run"));
  assert.ok(args.at(-1).startsWith("file://"), "the page url is the last argument");
  assert.ok(args.at(-1).endsWith("/arc/items/2026/10/X.html"));
});

function fakeSpawn(calls, { exitCode = 0, writeOutput = true, hang = false } = {}) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit("exit", null, "SIGKILL")); };
    if (!hang) {
      (async () => {
        await Promise.resolve(); // let captureThumbnail attach its listeners first
        if (writeOutput) {
          const out = args.find((a) => a.startsWith("--screenshot=")).slice("--screenshot=".length);
          await writeFile(out, "PNG");
        }
        child.emit("exit", exitCode, null);
      })();
    }
    return child;
  };
}

test("captureThumbnail writes the png atomically and cleans the temp profile", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wa-thumb-"));
  const out = join(dir, "X.png");
  const calls = [];
  await captureThumbnail({ browser: "/bin/chrome", htmlPath: join(dir, "X.html"), outPath: out, spawn: fakeSpawn(calls), tmpRoot: dir });
  assert.equal(calls[0].command, "/bin/chrome");
  assert.equal(await readFile(out, "utf8"), "PNG");
  const leftovers = (await readdir(dir)).filter((n) => n !== "X.png");
  assert.deepEqual(leftovers, [], "no temp profile or temp png left behind");
  assert.ok(calls[0].args.find((a) => a.startsWith("--screenshot=")).match(/\.tmp-\w+\.png$/), "chrome writes to a temp .png name, then rename");
});

test("captureThumbnail rejects when the browser exits non-zero or produces nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wa-thumb-"));
  await assert.rejects(captureThumbnail({ browser: "/bin/chrome", htmlPath: "x.html", outPath: join(dir, "a.png"), spawn: fakeSpawn([], { exitCode: 1 }), tmpRoot: dir }), /exited with 1/);
  await assert.rejects(captureThumbnail({ browser: "/bin/chrome", htmlPath: "x.html", outPath: join(dir, "b.png"), spawn: fakeSpawn([], { writeOutput: false }), tmpRoot: dir }), /no screenshot/);
  assert.deepEqual(await readdir(dir), []);
});

test("captureThumbnail kills the browser after the timeout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wa-thumb-"));
  const calls = [];
  await assert.rejects(captureThumbnail({ browser: "/bin/chrome", htmlPath: "x.html", outPath: join(dir, "a.png"), spawn: fakeSpawn(calls, { hang: true }), tmpRoot: dir, timeoutMs: 20 }), /timed out/);
  assert.deepEqual(await readdir(dir), []);
});

test("createThumbnailer renders queued items one at a time, dedupes, and re-indexes each result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wa-q-"));
  await writeFile(join(dir, "A.html"), "<html></html>");
  await writeFile(join(dir, "B.html"), "<html></html>");
  const captured = [];
  const upserted = [];
  const ctx = { archiveDir: dir, enabled: true, browser: "/bin/chrome", store: { upsert: (i) => upserted.push(i.id) }, readItem: async (relDir, id) => ({ id }) };
  let concurrent = 0;
  let maxConcurrent = 0;
  const capture = async ({ outPath }) => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((r) => setTimeout(r, 5));
    captured.push(outPath);
    concurrent--;
  };
  const q = createThumbnailer(ctx, { capture });
  q.enqueue(".", "A");
  q.enqueue(".", "A");
  q.enqueue(".", "B");
  q.enqueue(".", "missing");
  await q.idle();
  assert.deepEqual(captured, [join(dir, "A.png"), join(dir, "B.png")]);
  assert.deepEqual(upserted, ["A", "B"]);
  assert.equal(maxConcurrent, 1);
  ctx.enabled = false;
  assert.equal(await q.render(".", "A"), false, "render reports false when disabled");
  ctx.enabled = true;
  ctx.browser = null;
  assert.equal(await q.render(".", "A"), false, "render reports false without a browser");
});

test("createThumbnailer reports a failed render and keeps going", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wa-q-"));
  await writeFile(join(dir, "A.html"), "");
  await writeFile(join(dir, "B.html"), "");
  const errors = [];
  const done = [];
  const ctx = { archiveDir: dir, enabled: true, browser: "/bin/chrome", store: { upsert() {} }, readItem: async () => null };
  const capture = async ({ htmlPath }) => { if (htmlPath.endsWith("A.html")) { throw new Error("boom"); } };
  const q = createThumbnailer(ctx, { capture, onError: (e) => errors.push(e.message), onDone: (id) => done.push(id) });
  q.enqueue(".", "A");
  q.enqueue(".", "B");
  await q.idle();
  assert.deepEqual(errors, ["thumbnail for A: boom"]);
  assert.deepEqual(done, ["B"]);
});
