# webarchive-server

[SingleFile](https://www.getsinglefile.com/) でキャプチャしたページを Dropbox などの共有フォルダに保存し、メモ・タグを付けて検索するローカルサーバ。

保存先はローカルのフォルダとして見えるものなら何でもよい。Dropbox のほか、iCloud Drive、OneDrive、Google Drive for desktop、Syncthing、Nextcloud などのデスクトップクライアントで同期するフォルダで動く。
サーバは各サービスの API を使わず、フォルダへのファイル書き込みと変更監視だけで動作する。競合コピー(`<ULID>` で始まり `.json` で終わる別名ファイル)は、どのサービスが作ったものでも一覧に「競合」として表示する。

次の点に注意すること。

- **ファイルオンデマンドは切る。** Dropbox の「オンラインのみ」、OneDrive の Files On-Demand、iCloud の「Mac のストレージを最適化」、Google Drive の「ストリーミング」のように実体をローカルに置かない設定だと、ページ表示や索引構築のたびにダウンロードが走り、オフラインでは失敗する。保存先フォルダは「ローカルで利用可能にする」「常にこのデバイスに保持」にしておく。
- **ネットワークドライブ(SMB / NFS / WebDAV のマウント)は非推奨。** 他のマシンが書いた変更のイベントが届かず、再起動して索引を再構築するまで反映されない。

Node.js 22.13 以上が必要(索引に `node:sqlite` を使うため)。`package.json` の `engines` にもこの制約がある。

## インストールと起動

```bash
npm install -g github:ytx/webarchive-server
```

```bash
webarchive
```

リポジトリから直接動かす場合は `npm install` のあと `npm start`。

### 更新

同じコマンドをもう一度実行すると、GitHub の `main` の最新コミットを取得して上書きインストールする(`npm update -g` は git 参照のパッケージには効かない)。
特定のコミットやタグに固定したい場合は `github:ytx/webarchive-server#<コミットまたはタグ>` と書く。

```bash
npm install -g github:ytx/webarchive-server
```

サービスとして登録している場合、定義に書かれた `src/server.js` のパスは再インストール後も同じなので書き直しは不要。ただし起動中のプロセスは古いコードのまま動き続けるので、`webarchive service install` をもう一度実行して再起動すること。

初回起動時は保存先フォルダが未設定なので、サーバは `http://127.0.0.1:8765/settings` を既定のブラウザで開く。
設定画面で保存先フォルダ(Dropbox などの共有フォルダ)、マシン名、ポート、保存後にブラウザを開くかどうかを指定して保存すると、そのまま使い始められる。

設定画面は一覧画面のヘッダ「設定」からいつでも開ける。保存した内容はすぐに反映される(保存先フォルダを変えると索引を再構築する)。ポートだけは再起動後に有効になる。

## サービスとして常駐させる

SingleFile から常に保存できるよう、ログイン時に自動起動するサービスとして登録できる。macOS と Windows に対応(Linux は未対応)。

登録して今すぐ起動:

```bash
webarchive service install
```

登録・稼働状況を表示:

```bash
webarchive service status
```

停止して登録解除:

```bash
webarchive service uninstall
```

`install` は実行時の `node` と `src/server.js` の絶対パスを定義に書き込むので、Node やパッケージを入れ直した場合は `install` をやり直すこと。

| OS | 仕組み | 定義の場所 | ログ |
|---|---|---|---|
| macOS | launchd(LaunchAgent) | `~/Library/LaunchAgents/io.github.ytx.webarchive.plist` | `~/Library/Logs/webarchive/stdout.log`, `stderr.log` |
| Windows | タスクスケジューラ(ログオン時) | タスク名 `webarchive` | なし(コンソールウィンドウに出力) |

`install` 実行時に `WEBARCHIVE_CONFIG` や `ARCHIVE_DIR` などの設定系の環境変数が設定されていると、macOS ではその値を plist に固定で書き込む。設定画面から変更できるようにしたい場合は、環境変数を付けずに `install` すること。

Windows のログオン時タスクは node のコンソールウィンドウが表示される。閉じるとサーバも止まるので、最小化しておくこと。

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

