import { spawn as childSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rename, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

// Thumbnails are rendered by whatever Chromium-based browser is installed on
// the machine (Chrome, Edge, Brave, Chromium) using its built-in headless
// screenshot mode, so there is no browser download or native dependency.

const DARWIN_APPS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
];
const WIN_RELATIVE = [
  "Google\\Chrome\\Application\\chrome.exe",
  "Microsoft\\Edge\\Application\\msedge.exe",
  "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "Chromium\\Application\\chrome.exe"
];
const LINUX_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "brave-browser", "microsoft-edge"];

export function browserCandidates({ platform = process.platform, env = process.env } = {}) {
  if (platform === "darwin") {
    return [...DARWIN_APPS, ...DARWIN_APPS.map((p) => join(env.HOME ?? "", p))];
  }
  if (platform === "win32") {
    const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter(Boolean);
    // Browser preference outranks install location, same as on Linux below.
    return WIN_RELATIVE.flatMap((rel) => roots.map((root) => `${root}\\${rel}`));
  }
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  // Search by command name first so a preferred browser earlier in the list
  // wins regardless of which PATH entry holds it.
  return LINUX_NAMES.flatMap((name) => dirs.map((dir) => join(dir, name)));
}

// Returns the browser executable to use, or null. An explicitly configured
// path is authoritative: when it doesn't exist we report "none" rather than
// silently using a different browser than the user asked for.
export function findBrowser({ configured = "", platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (configured && configured.trim()) {
    return exists(configured.trim()) ? configured.trim() : null;
  }
  return browserCandidates({ platform, env }).find((path) => exists(path)) ?? null;
}

export const THUMB_WIDTH = 1280;
export const THUMB_HEIGHT = 800;
export const THUMB_SCALE = 0.5;

export function browserArgs({ profileDir, outPath, htmlPath, extraArgs = [] }) {
  return [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--mute-audio",
    // A private profile keeps this process independent of any running Chrome
    // (and keeps the saved page away from the user's cookies and sessions).
    `--user-data-dir=${profileDir}`,
    // The saved page is self-contained; forbid every outbound connection so
    // nothing in it can phone home while being rendered.
    "--host-rules=MAP * ~NOTFOUND",
    // Lay the page out at desktop width but emit a half-size bitmap.
    `--window-size=${THUMB_WIDTH},${THUMB_HEIGHT}`,
    `--force-device-scale-factor=${THUMB_SCALE}`,
    "--virtual-time-budget=3000",
    `--screenshot=${outPath}`,
    ...extraArgs,
    pathToFileURL(htmlPath).href
  ];
}

export async function captureThumbnail({ browser, htmlPath, outPath, spawn = childSpawn, tmpRoot = tmpdir(), timeoutMs = 60_000, extraArgs = [] }) {
  const profileDir = await mkdtemp(join(tmpRoot, "webarchive-thumb-"));
  // Chrome picks the image format from the extension, so the temp name must
  // still end in .png. The leading dot keeps classifyFile() treating it as
  // "other" until the rename.
  const tmpOut = join(dirname(outPath), `.${basename(outPath, ".png")}.tmp-${basename(profileDir).slice(-6)}.png`);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(browser, browserArgs({ profileDir, outPath: tmpOut, htmlPath, extraArgs }), { stdio: "ignore", windowsHide: true });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`thumbnail render timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
        } else if (code !== null) {
          reject(new Error(`browser exited with ${code}`));
        }
      });
    });
    if (!existsSync(tmpOut)) {
      throw new Error("browser produced no screenshot");
    }
    await rename(tmpOut, outPath);
  } catch (error) {
    await unlink(tmpOut).catch(() => {});
    throw error;
  } finally {
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function thumbnailPath(archiveDir, relDir, id) {
  return join(archiveDir, relDir, `${id}.png`);
}

// Serial queue in front of captureThumbnail. One browser at a time keeps the
// load predictable when a startup backfill has hundreds of pages to render.
// `ctx` exposes live archiveDir/machineName/browser/enabled getters and the
// store, so settings changes take effect for the next job.
export function createThumbnailer(ctx, { capture = captureThumbnail, onError = (error) => console.error(error), onDone = () => {} } = {}) {
  const queue = [];
  const queued = new Set();
  let running = null;

  async function run(relDir, id) {
    const browser = ctx.browser;
    if (!ctx.enabled || !browser || !ctx.archiveDir) {
      return false;
    }
    const htmlPath = join(ctx.archiveDir, relDir, `${id}.html`);
    if (!existsSync(htmlPath)) {
      return false;
    }
    await capture({ browser, htmlPath, outPath: thumbnailPath(ctx.archiveDir, relDir, id) });
    const fresh = await ctx.readItem(relDir, id);
    if (fresh) {
      ctx.store.upsert(fresh);
    }
    onDone(id);
    return true;
  }

  async function drain() {
    while (queue.length) {
      const { relDir, id } = queue.shift();
      try {
        await run(relDir, id);
      } catch (error) {
        onError(new Error(`thumbnail for ${id}: ${error.message}`));
      } finally {
        // Keep the id marked until the render finishes so a repeat enqueue
        // during the render is folded in rather than rendered twice.
        queued.delete(id);
      }
    }
    running = null;
  }

  return {
    get browser() {
      return ctx.browser;
    },
    enqueue(relDir, id) {
      if (queued.has(id)) {
        return;
      }
      queued.add(id);
      queue.push({ relDir, id });
      if (!running) {
        running = drain();
      }
    },
    // Render now, ahead of the queue, and surface the error to the caller.
    render(relDir, id) {
      return run(relDir, id);
    },
    get pending() {
      return queue.length;
    },
    async idle() {
      while (running) {
        await running;
      }
    }
  };
}
