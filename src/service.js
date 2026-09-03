import { execFile } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LABEL = "io.github.ytx.webarchive";
export const TASK_NAME = "webarchive";
const NODE_FLAGS = ["--disable-warning=ExperimentalWarning"];
// Environment variables that configure the server and are worth freezing into
// the service definition when they are set at install time.
const CONFIG_ENV = ["WEBARCHIVE_CONFIG", "ARCHIVE_DIR", "DATA_DIR", "PORT", "MACHINE_NAME", "OPEN_AFTER_SAVE"];

export function realExec(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function launchdPlist({ node, server, logDir, env = {} }) {
  const envEntries = CONFIG_ENV.filter((key) => env[key] !== undefined).map((key) => `    <key>${key}</key>\n    <string>${escapeXml(env[key])}</string>`);
  const envBlock = envEntries.length ? `  <key>EnvironmentVariables</key>\n  <dict>\n${envEntries.join("\n")}\n  </dict>\n` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(node)}</string>
${NODE_FLAGS.map((flag) => `    <string>${flag}</string>`).join("\n")}
    <string>${escapeXml(server)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(logDir, "stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(logDir, "stderr.log"))}</string>
${envBlock}</dict>
</plist>
`;
}

export function schtasksCommand({ node, server }) {
  return ["/Create", "/TN", TASK_NAME, "/SC", "ONLOGON", "/RL", "LIMITED", "/F", "/TR", `"${node}" ${NODE_FLAGS.join(" ")} "${server}"`];
}

function darwinPaths(home) {
  return { plist: join(home, "Library", "LaunchAgents", `${LABEL}.plist`), logDir: join(home, "Library", "Logs", "webarchive") };
}

function unsupported(platform) {
  return new Error(`service registration is not supported on ${platform} (macOS and Windows only)`);
}

export async function installService({ platform = process.platform, home = homedir(), uid = process.getuid?.(), node = process.execPath, server, env = process.env, exec = realExec }) {
  if (platform === "darwin") {
    const { plist, logDir } = darwinPaths(home);
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await mkdir(logDir, { recursive: true });
    await writeFile(plist, launchdPlist({ node, server, logDir, env }));
    // Replace a previous registration, if any; bootout failing is fine.
    await exec("launchctl", ["bootout", `gui/${uid}/${LABEL}`]);
    const result = await exec("launchctl", ["bootstrap", `gui/${uid}`, plist]);
    if (result.code !== 0) {
      throw new Error(`launchctl bootstrap failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return { path: plist, logDir };
  }
  if (platform === "win32") {
    const create = await exec("schtasks", schtasksCommand({ node, server }));
    if (create.code !== 0) {
      throw new Error(`schtasks /Create failed (${create.code}): ${create.stderr.trim() || create.stdout.trim()}`);
    }
    const run = await exec("schtasks", ["/Run", "/TN", TASK_NAME]);
    if (run.code !== 0) {
      throw new Error(`schtasks /Run failed (${run.code}): ${run.stderr.trim() || run.stdout.trim()}`);
    }
    return { path: TASK_NAME, logDir: null };
  }
  throw unsupported(platform);
}

export async function uninstallService({ platform = process.platform, home = homedir(), uid = process.getuid?.(), exec = realExec }) {
  if (platform === "darwin") {
    const { plist } = darwinPaths(home);
    const result = await exec("launchctl", ["bootout", `gui/${uid}/${LABEL}`]);
    const hadPlist = existsSync(plist);
    if (hadPlist) {
      await unlink(plist);
    }
    return { removed: result.code === 0 || hadPlist, path: plist };
  }
  if (platform === "win32") {
    const result = await exec("schtasks", ["/Delete", "/TN", TASK_NAME, "/F"]);
    return { removed: result.code === 0, path: TASK_NAME };
  }
  throw unsupported(platform);
}

export async function serviceStatus({ platform = process.platform, home = homedir(), uid = process.getuid?.(), exec = realExec }) {
  if (platform === "darwin") {
    const { plist } = darwinPaths(home);
    const result = await exec("launchctl", ["print", `gui/${uid}/${LABEL}`]);
    const loaded = result.code === 0;
    return { installed: loaded || existsSync(plist), running: loaded && /state = running/.test(result.stdout), path: plist };
  }
  if (platform === "win32") {
    const result = await exec("schtasks", ["/Query", "/TN", TASK_NAME]);
    return { installed: result.code === 0, running: result.code === 0 && /Running/.test(result.stdout), path: TASK_NAME };
  }
  throw unsupported(platform);
}
