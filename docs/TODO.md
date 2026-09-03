# 残件・先送り事項

最終レビュー(2026-09-03)で残った項目。上の 2 件は Dropbox 同期時のデータ安全に関わるので優先。

## 優先(データ安全)

1. **起動時のサイドカー自動生成の判定に mtime を使っている**(`src/item.js` の
   `SIDECAR_GENERATION_MIN_AGE_MS`)。Dropbox は同期先でも元の mtime を保持するため、
   同期直後の HTML が「5 分より古い」と判定され、他機の JSON が届く直前に空のサイドカーを
   生成して競合させる可能性がある。対策案: ローカル到着時刻を表す `ctime`/`birthtime` を
   使う、または自動生成をやめて UI の「メタデータを生成」ボタンに置き換える。
   回帰テスト: 監視フォルダに `<ULID>.html` だけを置き(mtime は古く設定)、再構築後も
   ディレクトリ内容が変わらないことを確認する。
2. **`pending`(同期中)が「HTML 先着・JSON 未着」も含むようになったが UI が追従していない**
   (`public/item.js` の `renderNotice` / `save`)。通知文は「HTML 未到着」のままで、メモ編集も
   可能なため、ユーザーの PATCH で空のサイドカーが作られ同じ競合が起きる。対策: `hasHtml` で
   通知文を分岐し、`status === "pending"` の間は `save()` を無効化する。

## その他(先送りで可と判定済み)

- `resolve` で本体サイドカーが壊れている場合の既定値が `sidecarDefaults` のまま
  (`sidecarFromHtml` を使うべき)。
- Host ヘッダが無い場合の分岐にテストがない。
- `refresh()` が null を返して 404 になる経路にテストがない。
- 64 MB の Content-Length 上限にテストがない。
- `Store#hydrate` が行ごとにタグを問い合わせる(50 件/ページで 50 クエリ)。
- `rebuildIndex` が項目ごとにディレクトリを読み直す。
- `DELETE` は `<ULID> (競合コピー).html` のような名前の HTML を消さない(`classifyFile` が
  `other` を返すため)。
- LIKE フォールバック(3 文字未満)がタグ境界をまたいで一致することがある。
- `toIsoWithOffset` の直接テストがない。`savedAt` のオフセットはサーバのタイムゾーン。
- 監視の `onError` 経路にテストがない。
- 取り込みの書き込み失敗以外の異常系(html が Buffer でも string でもない)は未防御。
- 項目画面: blur 保存と Cmd+S が重なると保存時刻表示が古い方になることがある。
  `beforeunload` に `returnValue` を設定していない。
- 自動保存経路では保存後にブラウザを開かない(設計どおり。`OPEN_AFTER_SAVE=false` 推奨)。
- 設定ファイル `config.json` の既定パスが cwd 相対。
