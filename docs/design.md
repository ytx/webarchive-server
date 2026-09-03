# ローカルアーカイブサーバ設計(SingleFile 連携)

作成日: 2026-09-03

## 目的

SingleFile でキャプチャしたページをローカルサーバへ保存し、メモ・タグを付け、
一覧・検索・編集できるようにする。保存先フォルダは Dropbox で複数マシンと共有し、
各マシンでサーバを起動して保存・閲覧・編集を行う。

## 前提・制約

- 利用者は一人。サーバは 127.0.0.1 にのみバインドし、認証は行わない。
- ブラウザは Chrome 系のみ。
- 検索対象はタイトル・URL・メモ・タグ。本文の全文検索は行わない。
- タグはフラット。自由入力と既存タグの補完。
- SingleFile 拡張は本家のまま使い、改修しない。
- サーバは Node.js で実装する(このリポジトリ)。

## 全体構成

```
Chrome(SingleFile 拡張)
  └─ POST multipart(file, url) ─▶ ローカルサーバ(Node.js, 127.0.0.1:PORT)
                                     ├─ 正本: ~/Dropbox/WebArchive/items/**.{html,json}
                                     ├─ 索引: ローカルの SQLite(再構築可能)
                                     └─ Web UI(一覧・検索・編集・閲覧)
Dropbox が items/ を他マシンへ同期 ── 各マシンのサーバが監視して索引を更新
```

サーバは受信成功後、編集画面 URL を既定ブラウザで開く(設定で無効化可)。
「保存時に入力」と「後から編集」は同じ画面で行う。

## 1. データ配置

正本は Dropbox 内の平文ファイルのみ。SQLite は Dropbox 外に置き、いつでも削除・再構築できる。

```
<ARCHIVE_DIR>/                    例: ~/Dropbox/WebArchive
  items/
    YYYY/MM/
      <ULID>.html                 SingleFile のキャプチャ(無加工)
      <ULID>.json                 サイドカー(メタデータ)
<DATA_DIR>/index.sqlite           例: ~/.local/share/webarchive(マシン固有)
```

サイドカー JSON:

```json
{
  "id": "01JXXXXXXXXXXXXXXXXXXXXXKQ",
  "url": "https://example.com/article",
  "title": "記事タイトル",
  "savedAt": "2026-09-03T10:12:00+09:00",
  "savedOn": "macbook",
  "memo": "後で読む。第3章が重要",
  "tags": ["research", "javascript"],
  "updatedAt": "2026-09-03T10:15:30+09:00"
}
```

- `id` は ULID。時刻順に並び、マシン間で衝突しない。ファイル名と一致させる。
- `savedOn` は設定で与えるマシン名。
- `tags` は小文字化・前後空白除去・重複除去して保存する。
- タグ一覧は別ファイルで管理せず、全サイドカーから集計する。
- 削除は HTML と JSON の両方を削除する(ゴミ箱は設けない。Dropbox の履歴で復元できる)。

## 2. 索引と同期

- 起動時に `items/` を走査して SQLite を全再構築する。
- 起動後は chokidar で `items/` を監視し、`*.json` の追加・変更・削除を索引へ反映する。
  HTML は存在確認のみ(`hasHtml` フラグ)。
- 自サーバが書いた変更も監視経由で二重に処理されるが、内容が同じなので冪等に扱う。
- 監視イベントは短時間(例 300ms)デバウンスし、Dropbox の部分書き込みを避ける。

### SQLite スキーマ

```sql
CREATE TABLE items (
  id TEXT PRIMARY KEY, url TEXT, title TEXT, memo TEXT,
  saved_at TEXT, saved_on TEXT, updated_at TEXT,
  rel_dir TEXT NOT NULL,           -- items/YYYY/MM
  has_html INTEGER NOT NULL,
  status TEXT NOT NULL,            -- ok | conflict | broken | pending
  conflict_files TEXT NOT NULL DEFAULT '[]'  -- 競合コピーのファイル名(JSON 配列)
);
CREATE TABLE item_tags (item_id TEXT, tag TEXT, PRIMARY KEY (item_id, tag));
CREATE VIRTUAL TABLE items_fts USING fts5(id UNINDEXED, title, url, memo, tags,
  tokenize = 'trigram');
```

日本語のメモ・タイトルを部分一致で検索するため FTS5 の trigram トークナイザを使う。

### 競合

同じ項目を2台で同時編集すると Dropbox が競合コピー
(`<ULID> (競合コピー ...).json` など、ロケール依存の名前)を作る。

- `<ULID>` で始まり `.json` で終わる、ULID 単体でないファイルを競合コピーとみなす。
- 該当項目の `status` を `conflict` にし、一覧に表示する。
- 項目画面で両方の memo/tags を並べて表示し、どちらかを採用すると
  採用した内容で `<ULID>.json` を書き、競合コピーを削除する。
- 自動マージはしない。

## 3. サーバ

- Node.js 22 以降。Hono、`node:sqlite`、chokidar、ulid。
- 設定は環境変数または設定ファイル(`~/.config/webarchive/config.json`、
  `XDG_CONFIG_HOME` と `WEBARCHIVE_CONFIG` を尊重)で与える:
  `ARCHIVE_DIR`、`DATA_DIR`、`PORT`(既定 8765)、`MACHINE_NAME`(既定 hostname)、
  `OPEN_AFTER_SAVE`(既定 true、保存後に既定ブラウザで編集画面を開く)。環境変数が優先。
- `ARCHIVE_DIR` が未設定なら「未設定状態」で起動し、`/settings` を既定ブラウザで開く。
  未設定の間は `/` と `/items/*` を `/settings` にリダイレクトし、アーカイブ系 API は 503 を返す。
- 設定画面(`/settings`)からの保存は設定ファイルへ書き、`archiveDir`/`machineName` の変更は
  索引の再構築と監視の張り直しでその場で反映する。`port` の変更は再起動後に有効。
  環境変数で与えた項目は設定画面では読み取り専用。
- `webarchive service install|uninstall|status` でログイン時自動起動として登録できる
  (macOS は launchd の LaunchAgent、Windows はタスクスケジューラ。`src/service.js`)。
- 127.0.0.1 のみにバインド。CORS は拡張からの POST を許可するため
  `chrome-extension://` オリジンに限って許可する。

### API

| メソッド・パス | 内容 |
|---|---|
| `POST /api/singlefile` | SingleFile REST form API 形式(multipart: `file`, `url`)。HTML と JSON を書き、`{ "id", "openUrl" }` を返す。`openUrl` は `http://127.0.0.1:PORT/items/<id>?new=1` |
| `GET /api/items?q=&tag=&status=&page=&limit=` | 検索・一覧。新しい順。`q` は FTS、`tag` は完全一致 |
| `GET /api/items/:id` | 1件取得(競合時は競合コピーの内容も含む) |
| `PATCH /api/items/:id` | `memo`、`tags` を更新。サイドカーへ書き戻し、`updatedAt` を更新 |
| `POST /api/items/:id/resolve` | 競合解決。`{ "choose": "main" \| "conflict:<filename>" }` |
| `DELETE /api/items/:id` | HTML と JSON を削除 |
| `GET /api/tags` | `[{ "tag", "count" }]` |
| `GET /items/:id/page` | 保存 HTML を配信。`Content-Security-Policy: sandbox` を付ける |
| `GET /api/settings` | 設定値、項目ごとの由来(`env`/`file`/`default`)、設定ファイルのパス、`configured` |
| `PUT /api/settings` | `archiveDir`、`port`、`machineName`、`openAfterSave` を検証して保存・反映。`restartRequired` を返す |
| `GET /`, `GET /items/:id`, `GET /settings` | Web UI |

タイトルは受信 HTML の `<title>` から抽出する。無ければ multipart のファイル名(拡張子除去)を使う。
受信 HTML は SingleFile の出力をそのまま保存し、加工しない。

### 書き込みの原子性

サイドカーは一時ファイルに書いてから rename する。Dropbox が中途半端な内容を同期するのを防ぐ。

## 4. Web UI

サーバが配信する素の HTML/CSS/JS(ビルド不要)。
モックアップ: https://claude.ai/code/artifact/b02d74a0-07c9-445e-a575-9abba256819c(案A「実用・高密度」を採用)。
管理ツール風の高密度レイアウト。ヘッダに検索ボックス、左サイドバーに状態(すべて・タグなし・競合あり)と
タグ一覧(件数付き)、本文は 1 件 2 行(タイトル / ドメインとメモ冒頭)の行リスト。
項目画面は左 420px にメタデータ・メモ・タグ、右に保存ページのプレビュー。

- 一覧画面 `/`
  - 検索ボックス(タイトル・URL・メモ・タグ)、タグ絞り込み(タグ一覧を件数付きで表示)。
  - 各行: タイトル、ドメイン、タグ、保存日、メモ冒頭、状態(競合・要修復・同期中)。
  - 新しい順、ページング。
- 項目画面 `/items/:id`
  - 元 URL リンク、保存日、保存元マシン。
  - メモ欄(textarea)、タグ入力(既存タグを補完、Enter で確定、Backspace で末尾削除)。
  - 保存ページを iframe(`sandbox` 属性付き)で表示。
  - 保存はフォーカスが外れたとき、または Cmd/Ctrl+S。保存結果を小さく表示する。
  - `?new=1` で開いたときはメモ欄へ自動フォーカス。
  - 削除ボタン(確認あり)。競合時は両方の内容を並べて選択できる。

## 5. SingleFile 側の設定(拡張の改修なし)

拡張は本家のまま使う。保存先に「REST form API」を選び、次のとおり設定する。

| 設定 | 値 |
|---|---|
| 保存先 | REST form API |
| URL | `http://127.0.0.1:8765/api/singlefile` |
| ファイルのフィールド名 | `file` |
| URL のフィールド名 | `url` |
| トークン | 任意(サーバは検証しない) |

「保存直後にメモ・タグを入力する」流れは、サーバが受信成功後に自分で既定ブラウザを開くことで
実現する(macOS `open`、Linux `xdg-open`、Windows `cmd /c start`)。設定 `openAfterSave`
(環境変数 `OPEN_AFTER_SAVE`、既定 true)で無効化できる。自動保存やバッチ保存を使う場合は
タブが増え続けるので無効にする。レスポンスの `openUrl` は互換のため残す。

当初は拡張に「レスポンスの URL を開く」オプションを追加する案だった(fork のブランチ
`local-archive-open-url` に実装済み)が、一人・同一 PC・localhost という前提ではサーバ側で
開く方が upstream 追従に有利なため、この方式に変更した。

## 6. エラー処理

- サーバ未起動: SingleFile が通信エラーを表示する。拡張側の追加処理は不要。
- サイドカーの JSON が壊れている: `status = broken` として一覧に表示し、
  項目画面で URL・タイトルを手入力して修復できる。
- JSON が先に届き HTML が未着: `status = pending`(同期中)。HTML 到着で `ok` にする。
- HTML だけあり JSON がない: 監視経路や API 経路では JSON を書かず、HTML のヘッダから
  URL・タイトルを取って `pending`(同期中)として索引する(Dropbox が JSON を後から届ける場合に
  自機で空のサイドカーを作って競合させないため)。起動時走査に限り、HTML の更新時刻が 5 分より
  古いものだけ JSON を生成する(URL は SingleFile が HTML 先頭に埋め込むコメント `url:` から、
  タイトルは `<title>` から)。
- localhost 専用でも DNS リバインディングで任意サイトから到達できるため、`Host` ヘッダが
  `127.0.0.1:PORT` / `localhost:PORT` / `[::1]:PORT` 以外なら 403 を返す。`POST /api/singlefile` は
  CORS のプリフライトが無いので、`Origin` ヘッダがあり拡張のオリジンでなければ 403 を返す。
- 受信時のディスク書き込み失敗: HTTP 500 を返し、部分的に書けたファイルは削除する。

## 7. テスト

- サーバ: Node 組み込みテストランナー。一時ディレクトリを `ARCHIVE_DIR` にした統合テスト。
  - 受信(POST)→ ファイル生成 → 索引登録 → 一覧・検索で取得できる。
  - 起動時再構築が JSON の内容と一致する。
  - 監視: 外部から JSON を書き換えると索引へ反映される(Dropbox 同期の模擬)。
  - 競合コピーの検出と解決。
  - 壊れた JSON、HTML 未着の扱い。
  - FTS の日本語部分一致。
- 拡張: 無改造。ローカルサーバへ実際に保存して手動確認する。

## 対象外(今回はやらない)

- 本文の全文検索、階層タグ、複数ユーザー、認証、外部からのアクセス。
- 既存のダウンロード済み HTML の一括取り込み(必要なら後で `items/` に置くだけで取り込める)。
