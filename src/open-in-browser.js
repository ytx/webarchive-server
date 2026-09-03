import { spawn as childSpawn } from "node:child_process";

function commandFor(platform, url) {
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] };
  }
  return { command: "xdg-open", args: [url] };
}

export function openInBrowser(url, { platform = process.platform, spawn = childSpawn } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.resolve(false);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return Promise.resolve(false);
  }
  const { command, args } = commandFor(platform, url);
  return new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("spawn", () => resolve(true));
    child.once("error", () => resolve(false));
    child.unref();
  });
}
