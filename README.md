# webarchive-server

SingleFile でキャプチャしたページを Dropbox 共有フォルダに保存し、メモ・タグを付けて検索するローカルサーバ。

Node.js 22.13 以上が必要(索引に `node:sqlite` を使うため)。`package.json` の `engines` にもこの制約がある。

## インストールと起動

```bash
npm install -g github:ytx/webarchive-server
webarchive
```

リポジトリから直接動かす場合は `npm install` のあと `npm start`。

初回起動時は保存先フォルダが未設定なので、サーバは `http://127.0.0.1:8765/settings` を既定のブラウザで開く。
設定画面で保存先フォルダ(Dropbox 共有フォルダ)、マシン名、ポート、保存後にブラウザを開くかどうかを指定して保存すると、そのまま使い始められる。

設定画面は一覧画面のヘッダ「設定」からいつでも開ける。保存した内容はすぐに反映される(保存先フォルダを変えると索引を再構築する)。ポートだけは再起動後に有効になる。

## 設定ファイル

設定は `~/.config/webarchive/config.json`(`XDG_CONFIG_HOME` が設定されていればその下の `webarchive/config.json`)に保存される。
`WEBARCHIVE_CONFIG` 環境変数でファイルの場所を変更できる。設定画面で保存するとこのファイルが書かれる。

```json
{ "archiveDir": "/Users/me/Dropbox/WebArchive", "port": 8765, "machineName": "macbook", "openAfterSave": true }
```

環境変数でも指定でき、環境変数が設定ファイルより優先される。環境変数で指定した項目は設定画面では読み取り専用になる。

```bash
ARCHIVE_DIR=~/Dropbox/WebArchive MACHINE_NAME=macbook webarchive
```

| 環境変数 | 設定ファイルのキー | 既定 |
|---|---|---|
| `ARCHIVE_DIR` | `archiveDir` | なし(未設定なら設定画面を開く) |
| `DATA_DIR` | `dataDir` | `~/.local/share/webarchive`(索引 SQLite の置き場。設定画面には出ない) |
| `PORT` | `port` | `8765` |
| `MACHINE_NAME` | `machineName` | ホスト名 |
| `OPEN_AFTER_SAVE` | `openAfterSave` | `true` |
| `WEBARCHIVE_CONFIG` | (ファイル自体の場所) | `~/.config/webarchive/config.json` |

設定ファイル内のパスはシェルを経由しないため `~` は展開されない。`archiveDir`/`dataDir` には
`/Users/me/Dropbox/WebArchive` のような絶対パスを書くこと(設定画面から入力した場合は先頭の `~/` をホームに展開して保存する)。
`ARCHIVE_DIR=~/Dropbox/WebArchive` のように環境変数として指定した場合はシェルが `~` を展開する。

以前のバージョンではカレントディレクトリの `config.json` を読んでいた。今は読まないので、上記の場所へ移動すること(起動時に警告を出す)。

索引 SQLite は `~/.local/share/webarchive/index.sqlite`(`DATA_DIR` で変更可)。削除しても起動時に再構築される。

## SingleFile の設定

| 設定 | 値 |
|---|---|
| 保存先 | REST form API |
| URL | `http://127.0.0.1:8765/api/singlefile` |
| ファイルのフィールド名 | `file` |
| URL のフィールド名 | `url` |
| 認証トークン | 任意(検証しない) |

SingleFile 側の変更は不要。保存後に開くタブはサーバ自身がデフォルトブラウザで開く。

## 保存後に自動でタブを開く

保存が成功すると、サーバはレスポンスに含まれる `openUrl` を既定のブラウザで自動的に開く(`OPEN_AFTER_SAVE`、既定で有効)。

```bash
OPEN_AFTER_SAVE=false webarchive
```

設定画面のチェックボックス、または設定ファイルでも指定できる。

```json
{ "openAfterSave": false }
```

`OPEN_AFTER_SAVE` の値は `false` / `0` / `no` / `off`(大文字小文字は区別しない)のいずれかで無効になり、それ以外は有効として扱われる。環境変数が `config.json` より優先される。

SingleFile の自動保存(autosave)やバッチ保存でタブが大量に開いてしまう場合は無効にすること。

## テスト

```bash
npm test
```
