import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { openInBrowser } from "../src/open-in-browser.js";

function fakeSpawn(calls, { fail = false } = {}) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit(fail ? "error" : "spawn"));
    return child;
  };
}

test("darwin uses `open`", async () => {
  const calls = [];
  const ok = await openInBrowser("http://127.0.0.1:8765/items/abc?new=1", { platform: "darwin", spawn: fakeSpawn(calls) });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "open");
  assert.deepEqual(calls[0].args, ["http://127.0.0.1:8765/items/abc?new=1"]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, "ignore");
});

test("linux (and other non-darwin/win32 platforms) uses xdg-open", async () => {
  const calls = [];
  const ok = await openInBrowser("http://127.0.0.1:8765/items/abc?new=1", { platform: "linux", spawn: fakeSpawn(calls) });
  assert.equal(ok, true);
  assert.equal(calls[0].command, "xdg-open");
  assert.deepEqual(calls[0].args, ["http://127.0.0.1:8765/items/abc?new=1"]);
});

test("win32 uses cmd /c start", async () => {
  const calls = [];
  const ok = await openInBrowser("http://127.0.0.1:8765/items/abc?new=1", { platform: "win32", spawn: fakeSpawn(calls) });
  assert.equal(ok, true);
  assert.equal(calls[0].command, "cmd");
  assert.deepEqual(calls[0].args, ["/c", "start", "", "http://127.0.0.1:8765/items/abc?new=1"]);
});

test("resolves false when spawn emits error", async () => {
  const calls = [];
  const ok = await openInBrowser("http://127.0.0.1:8765/items/abc?new=1", { platform: "darwin", spawn: fakeSpawn(calls, { fail: true }) });
  assert.equal(ok, false);
});

test("refuses a javascript: URL without spawning", async () => {
  const calls = [];
  const ok = await openInBrowser("javascript:alert(1)", { platform: "darwin", spawn: fakeSpawn(calls) });
  assert.equal(ok, false);
  assert.equal(calls.length, 0);
});

test("accepts https: URLs", async () => {
  const calls = [];
  const ok = await openInBrowser("https://example.com/", { platform: "darwin", spawn: fakeSpawn(calls) });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
});
