# webarchive-server

SingleFile でキャプチャしたページを Dropbox 共有フォルダに保存し、メモ・タグを付けて検索するローカルサーバ。

## 起動

```bash
npm install
ARCHIVE_DIR=~/Dropbox/WebArchive MACHINE_NAME=macbook npm start
```

`config.json`(リポジトリ直下、git 管理外)でも指定できる。環境変数が優先。

```json
{ "archiveDir": "/Users/me/Dropbox/WebArchive", "port": 8765, "machineName": "macbook" }
```

索引 SQLite は `~/.local/share/webarchive/index.sqlite`(`DATA_DIR` で変更可)。削除しても起動時に再構築される。

## SingleFile の設定

| 設定 | 値 |
|---|---|
| 保存先 | REST form API |
| URL | `http://127.0.0.1:8765/api/singlefile` |
| ファイルのフィールド名 | `file` |
| URL のフィールド名 | `url` |
| 認証トークン | 任意(検証しない) |
| 保存後にレスポンスの URL を開く | 有効 |

## テスト

```bash
npm test
```
