# webarchive-server

SingleFile でキャプチャしたページを Dropbox 共有フォルダに保存し、メモ・タグを付けて検索するローカルサーバ。

Node.js 22.13 以上が必要(索引に `node:sqlite` を使うため)。`package.json` の `engines` にもこの制約がある。

## 起動

```bash
npm install
ARCHIVE_DIR=~/Dropbox/WebArchive MACHINE_NAME=macbook npm start
```

`config.json`(リポジトリ直下、git 管理外)でも指定できる。環境変数が優先。

```json
{ "archiveDir": "/Users/me/Dropbox/WebArchive", "port": 8765, "machineName": "macbook" }
```

`config.json` 内のパスはシェルを経由しないため `~` は展開されない。`archiveDir`/`dataDir` には
`/Users/me/Dropbox/WebArchive` のような絶対パスを書くこと。`~` が展開されるのは
`ARCHIVE_DIR=~/Dropbox/WebArchive` のように環境変数としてシェル側で指定した場合のみ。

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
OPEN_AFTER_SAVE=false npm start
```

`config.json` でも指定できる。

```json
{ "openAfterSave": false }
```

`OPEN_AFTER_SAVE` の値は `false` / `0` / `no` / `off`(大文字小文字は区別しない)のいずれかで無効になり、それ以外は有効として扱われる。環境変数が `config.json` より優先される。

SingleFile の自動保存(autosave)やバッチ保存でタブが大量に開いてしまう場合は無効にすること。

## テスト

```bash
npm test
```
