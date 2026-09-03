#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installService, uninstallService, serviceStatus } from "./service.js";

const SERVER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "server.js");

const USAGE = `Usage:
  webarchive                    start the server
  webarchive service install    register the server to start at login and start it now
  webarchive service uninstall  stop the server and remove the registration
  webarchive service status     show whether the service is registered and running
  webarchive help               show this help

Service registration is supported on macOS (launchd) and Windows (Task Scheduler).
`;

export async function runCli(argv, {
  stdout = process.stdout,
  stderr = process.stderr,
  startServer = () => import("./server.js"),
  service = { install: installService, uninstall: uninstallService, status: serviceStatus }
} = {}) {
  const [command, sub] = argv;
  if (command === undefined) {
    await startServer();
    return 0;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    stdout.write(USAGE);
    return 0;
  }
  if (command !== "service" || !["install", "uninstall", "status"].includes(sub)) {
    stderr.write(USAGE);
    return 1;
  }
  try {
    if (sub === "install") {
      const { path, logDir } = await service.install({ server: SERVER_SCRIPT });
      stdout.write(`service installed and started: ${path}\n`);
      if (logDir) {
        stdout.write(`logs: ${logDir}\n`);
      }
    } else if (sub === "uninstall") {
      const { removed, path } = await service.uninstall({});
      stdout.write(removed ? `service removed: ${path}\n` : `service was not installed (${path})\n`);
    } else {
      const { installed, running, path } = await service.status({});
      stdout.write(`installed: ${installed ? "yes" : "no"}\nrunning: ${running ? "yes" : "no"}\ndefinition: ${path}\n`);
    }
    return 0;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

// npm installs the bin as a symlink, so argv[1] is the link while
// import.meta.url is the resolved file: compare real paths.
function invokedDirectly() {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const code = await runCli(process.argv.slice(2));
  if (code !== 0 || process.argv.length > 2) {
    process.exit(code);
  }
}
