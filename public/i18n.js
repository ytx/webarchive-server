// UI strings. Static markup uses data-i18n="key" (and data-i18n-placeholder /
// data-i18n-title for attributes); script-built text goes through t().
const STRINGS = {
  ja: {
    "app.title": "WebArchive",
    "nav.back": "← 一覧へ戻る",
    "nav.settings": "設定",
    "nav.language": "言語を切り替え (English)",
    "nav.theme.dark": "ダークモードに切り替え",
    "nav.theme.light": "ライトモードに切り替え",
    "unload.confirm": "このタブを閉じますか?",

    "list.search": "タイトル・URL・メモ・タグを検索",
    "list.status": "状態",
    "list.tags": "タグ",
    "list.all": "すべて",
    "list.untagged": "タグなし",
    "list.conflicts": "競合あり",
    "list.sort": "並び: 保存日 新しい順",
    "list.items": "{n} items",
    "list.empty": "該当する項目はありません",
    "list.loadFailed": "読み込みに失敗しました: {message}",
    "list.openNewTab": "新しいタブで開く",
    "badge.conflict": "競合",
    "badge.pending": "同期中",
    "badge.broken": "要修復",
    "chip.none": "タグなし",

    "item.saved": "保存済み",
    "item.savedAt": "保存済み {time}",
    "item.saving": "保存中…",
    "item.unsaved": "未保存",
    "item.saveFailed": "保存に失敗: {message}",
    "item.noTitle": "(タイトルなし)",
    "item.memo": "メモ",
    "item.memoHint": "フォーカスが外れると保存 · Cmd+S",
    "item.tags": "タグ",
    "item.addTag": "タグを追加…",
    "item.removeTag": "削除",
    "item.newTag": "新しいタグ \"{tag}\" を作成",
    "item.openOriginal": "元ページを開く",
    "item.download": "HTML をダウンロード",
    "item.delete": "削除",
    "item.deleteConfirm": "この項目と保存した HTML を削除します。よろしいですか?",
    "item.savedPage": "保存したページ",
    "item.openNewTab": "新しいタブで開く",
    "item.loadFailed": "読み込みに失敗しました: {message}",
    "item.conflict": "別のマシンで同時に編集されたため、同期サービスが競合コピーを作成しました。採用する内容を選んでください。",
    "item.conflictMain": "このマシンの内容(現在の表示)",
    "item.unreadable": "(読み取り不能)",
    "item.noMemo": "(メモなし)",
    "item.noTags": "(タグなし)",
    "item.adopt": "この内容を採用",
    "item.broken": "メタデータ(JSON)が壊れています。URL とタイトルを入力して保存すると修復されます。",
    "item.brokenUrl": "URL",
    "item.brokenTitle": "タイトル",
    "item.repair": "修復して保存",
    "item.pending": "HTML がまだ同期されていません(同期サービスの到着待ち)。",

    "settings.title": "設定",
    "settings.firstRun": "初期設定",
    "settings.introFirstRun": "保存先フォルダを指定すると使い始められます。設定はここに表示されたファイルに保存されます。",
    "settings.intro": "変更は保存時にすぐ反映されます(ポートのみ再起動後)。",
    "settings.archiveDir": "保存先フォルダ(archiveDir)",
    "settings.archiveDirHint": "SingleFile で保存したページを置く Dropbox などの共有フォルダ。絶対パス、または ~/ から始まるパス。",
    "settings.machineName": "マシン名(machineName)",
    "settings.machineNameHint": "どのマシンで保存したかを記録する名前。",
    "settings.port": "ポート(port)",
    "settings.portHint": "変更はサーバの再起動後に有効。SingleFile 側の URL も合わせて変更すること。",
    "settings.openAfterSave": "保存後に編集画面を既定のブラウザで開く(openAfterSave)",
    "settings.save": "保存",
    "settings.saving": "保存中…",
    "settings.saved": "保存しました",
    "settings.envLocked": "環境変数 {name} で指定されているため、ここでは変更できません。",
    "settings.restart": "ポートの変更はサーバを再起動すると有効になります。",
    "settings.rejected": "保存できませんでした: {message}",
    "settings.failed": "保存に失敗しました: {message}",
    "settings.loadFailed": "読み込みに失敗しました: {message}",
    "settings.lastError": "前回の保存先フォルダを開けなかったため、未設定の状態で起動しています: {message}"
  },
  en: {
    "app.title": "WebArchive",
    "nav.back": "← Back to list",
    "nav.settings": "Settings",
    "nav.language": "Switch language (日本語)",
    "nav.theme.dark": "Switch to dark mode",
    "nav.theme.light": "Switch to light mode",
    "unload.confirm": "Close this tab?",

    "list.search": "Search title, URL, memo, tags",
    "list.status": "STATUS",
    "list.tags": "TAGS",
    "list.all": "All",
    "list.untagged": "Untagged",
    "list.conflicts": "Conflicts",
    "list.sort": "Sort: newest saved first",
    "list.items": "{n} items",
    "list.empty": "No matching items",
    "list.loadFailed": "Failed to load: {message}",
    "list.openNewTab": "Open in new tab",
    "badge.conflict": "conflict",
    "badge.pending": "syncing",
    "badge.broken": "repair",
    "chip.none": "untagged",

    "item.saved": "Saved",
    "item.savedAt": "Saved {time}",
    "item.saving": "Saving…",
    "item.unsaved": "Unsaved",
    "item.saveFailed": "Save failed: {message}",
    "item.noTitle": "(untitled)",
    "item.memo": "MEMO",
    "item.memoHint": "Saved on blur · Cmd+S",
    "item.tags": "TAGS",
    "item.addTag": "Add tag…",
    "item.removeTag": "Remove",
    "item.newTag": "Create new tag \"{tag}\"",
    "item.openOriginal": "Open original",
    "item.download": "Download HTML",
    "item.delete": "Delete",
    "item.deleteConfirm": "Delete this item and its saved HTML?",
    "item.savedPage": "Saved page",
    "item.openNewTab": "Open in new tab",
    "item.loadFailed": "Failed to load: {message}",
    "item.conflict": "This item was edited on another machine at the same time and the sync service created a conflict copy. Choose which version to keep.",
    "item.conflictMain": "This machine (currently shown)",
    "item.unreadable": "(unreadable)",
    "item.noMemo": "(no memo)",
    "item.noTags": "(no tags)",
    "item.adopt": "Keep this version",
    "item.broken": "The metadata (JSON) is broken. Enter the URL and title and save to repair it.",
    "item.brokenUrl": "URL",
    "item.brokenTitle": "Title",
    "item.repair": "Repair and save",
    "item.pending": "The HTML has not been synced yet (waiting for the sync service).",

    "settings.title": "Settings",
    "settings.firstRun": "Initial setup",
    "settings.introFirstRun": "Pick an archive folder to get started. Settings are stored in the file shown above.",
    "settings.intro": "Changes take effect immediately when saved (the port after a restart).",
    "settings.archiveDir": "ARCHIVE FOLDER (archiveDir)",
    "settings.archiveDirHint": "Shared folder (Dropbox etc.) where SingleFile captures are stored. Absolute path, or one starting with ~/.",
    "settings.machineName": "MACHINE NAME (machineName)",
    "settings.machineNameHint": "Recorded on each item as the machine it was saved on.",
    "settings.port": "PORT (port)",
    "settings.portHint": "Takes effect after restarting the server. Update the URL in SingleFile as well.",
    "settings.openAfterSave": "Open the edit screen in the default browser after saving (openAfterSave)",
    "settings.save": "Save",
    "settings.saving": "Saving…",
    "settings.saved": "Saved",
    "settings.envLocked": "Set by the environment variable {name}; it cannot be changed here.",
    "settings.restart": "The port change takes effect after restarting the server.",
    "settings.rejected": "Could not save: {message}",
    "settings.failed": "Save failed: {message}",
    "settings.loadFailed": "Failed to load: {message}",
    "settings.lastError": "The previous archive folder could not be opened, so the server started unconfigured: {message}"
  }
};

const STORAGE_KEY = "webarchive.lang";

function stored() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function getLang() {
  const saved = stored();
  if (saved === "ja" || saved === "en") {
    return saved;
  }
  return (navigator.language ?? "").toLowerCase().startsWith("ja") ? "ja" : "en";
}

export function setLang(lang) {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // storage unavailable: the choice just won't persist
  }
}

export function t(key, params = {}) {
  const text = STRINGS[getLang()][key] ?? STRINGS.ja[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name) => (params[name] === undefined ? `{${name}}` : String(params[name])));
}

export function applyTranslations(root = document) {
  document.documentElement.lang = getLang();
  for (const el of root.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  for (const el of root.querySelectorAll("[data-i18n-title]")) {
    el.title = t(el.dataset.i18nTitle);
  }
}
