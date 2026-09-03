# webarchive-server

[日本語](README-ja.md)

A local server that stores pages captured with [SingleFile](https://www.getsinglefile.com/) in a shared folder such as Dropbox, and lets you annotate them with memos and tags and search them.

Any folder that appears as a local directory works as the archive. Besides Dropbox, folders synced by the desktop clients of iCloud Drive, OneDrive, Google Drive for desktop, Syncthing, Nextcloud and the like are fine.
The server does not use any service's API; it only writes files into the folder and watches it for changes. Conflict copies (files that start with the `<ULID>` and end with `.json` but are not the sidecar itself) are shown as "conflict" in the list no matter which service created them.

Keep the following in mind.

- **Turn off files on-demand.** Settings that keep no local copy, such as Dropbox "online-only", OneDrive Files On-Demand, iCloud "Optimize Mac Storage" or Google Drive "streaming", make every page view and index rebuild download files, and fail offline. Mark the archive folder "Make available offline" / "Always keep on this device".
- **Network mounts (SMB / NFS / WebDAV) are not recommended.** Change events for files written by other machines do not arrive, so they are not indexed until the server is restarted and the index rebuilt.

Node.js 22.13 or later is required (the index uses `node:sqlite`). The `engines` field in `package.json` enforces this.

## Install and run

```bash
npm install -g github:ytx/webarchive-server
```

```bash
webarchive
```

To run straight from the repository, `npm install` and then `npm start`.

### Updating

Run the same command again to fetch the latest commit on `main` from GitHub and install over the existing copy (`npm update -g` does not work for git-referenced packages).
To pin a specific commit or tag, write `github:ytx/webarchive-server#<commit-or-tag>`.

```bash
npm install -g github:ytx/webarchive-server
```

If the server is registered as a service, the path to `src/server.js` written into the service definition is the same after reinstalling, so the definition does not need to be rewritten. The running process keeps executing the old code, however, so run `webarchive service install` again to restart it.

On first start no archive folder is configured, so the server opens `http://127.0.0.1:8765/settings` in the default browser.
Enter the archive folder (a shared folder such as Dropbox), machine name, port and whether to open the browser after saving, press Save, and you are ready to go.

The settings screen can be opened at any time from the gear icon at the right end of the list header. Next to it are toggles for the display language (日本語 / English) and dark / light mode; the choices are remembered per browser (the defaults follow the browser language and the OS appearance). Closing the tab asks for confirmation (moving between the list, item and settings screens does not). Saved settings take effect immediately (changing the archive folder rebuilds the index). Only the port takes effect after a restart.

## Running as a service

So that SingleFile can save at any time, the server can be registered as a service that starts at login. macOS and Windows are supported (Linux is not).

Register and start now:

```bash
webarchive service install
```

Show registration and running state:

```bash
webarchive service status
```

Stop and unregister:

```bash
webarchive service uninstall
```

`install` writes the absolute paths of the current `node` and `src/server.js` into the definition, so run `install` again after reinstalling Node or the package.

| OS | Mechanism | Definition | Logs |
|---|---|---|---|
| macOS | launchd (LaunchAgent) | `~/Library/LaunchAgents/io.github.ytx.webarchive.plist` | `~/Library/Logs/webarchive/stdout.log`, `stderr.log` |
| Windows | Task Scheduler (at logon) | task named `webarchive` | none (written to the console window) |

If configuration environment variables such as `WEBARCHIVE_CONFIG` or `ARCHIVE_DIR` are set when `install` runs, on macOS their values are frozen into the plist. To keep those values editable from the settings screen, run `install` without them.

The Windows logon task shows a console window for node. Closing it stops the server, so minimize it instead.

## Configuration file

Settings are stored in `~/.config/webarchive/config.json` (or `webarchive/config.json` under `XDG_CONFIG_HOME` when that is set).
The `WEBARCHIVE_CONFIG` environment variable changes the file's location. Saving from the settings screen writes this file.

```json
{ "archiveDir": "/Users/me/Dropbox/WebArchive", "port": 8765, "machineName": "macbook", "openAfterSave": true }
```

Everything can also be given as environment variables, which take precedence over the file. Values set through environment variables are read-only in the settings screen.

```bash
ARCHIVE_DIR=~/Dropbox/WebArchive MACHINE_NAME=macbook webarchive
```

| Environment variable | Config file key | Default |
|---|---|---|
| `ARCHIVE_DIR` | `archiveDir` | none (the settings screen opens when unset) |
| `DATA_DIR` | `dataDir` | `~/.local/share/webarchive` (where the SQLite index lives; not shown in the settings screen) |
| `PORT` | `port` | `8765` |
| `MACHINE_NAME` | `machineName` | host name |
| `OPEN_AFTER_SAVE` | `openAfterSave` | `true` |
| `WEBARCHIVE_CONFIG` | (location of the file itself) | `~/.config/webarchive/config.json` |

Paths in the configuration file do not pass through a shell, so `~` is not expanded. Write absolute paths such as
`/Users/me/Dropbox/WebArchive` for `archiveDir` / `dataDir` (a value entered in the settings screen has a leading `~/` expanded to the home directory before it is saved).
When given as an environment variable such as `ARCHIVE_DIR=~/Dropbox/WebArchive`, the shell expands `~`.

Earlier versions read `config.json` from the current directory. That file is no longer read; move it to the location above (the server prints a warning at startup).

The SQLite index is `~/.local/share/webarchive/index.sqlite` (change with `DATA_DIR`). It can be deleted at any time and is rebuilt on startup.

## SingleFile settings

| Setting | Value |
|---|---|
| Destination | REST form API |
| URL | `http://127.0.0.1:8765/api/singlefile` |
| File field name | `file` |
| URL field name | `url` |
| Authorization token | anything (not checked) |

## Opening a tab automatically after saving

When a save succeeds, the server opens the `openUrl` from the response in the default browser (`OPEN_AFTER_SAVE`, enabled by default).

```bash
OPEN_AFTER_SAVE=false webarchive
```

It can also be set with the checkbox in the settings screen or in the configuration file.

```json
{ "openAfterSave": false }
```

`OPEN_AFTER_SAVE` is disabled by any of `false` / `0` / `no` / `off` (case-insensitive); every other value enables it. The environment variable takes precedence over `config.json`.

Disable it if SingleFile's autosave or batch saving opens too many tabs.
