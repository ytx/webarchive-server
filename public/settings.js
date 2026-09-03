const form = document.getElementById("settingsForm");
const saveStatus = document.getElementById("saveStatus");
const notice = document.getElementById("notice");
const FIELDS = ["archiveDir", "machineName", "port", "openAfterSave"];
const ENV_NAMES = { archiveDir: "ARCHIVE_DIR", machineName: "MACHINE_NAME", port: "PORT", openAfterSave: "OPEN_AFTER_SAVE" };
let current = null;

function input(key) {
  return document.getElementById(key);
}

function setNotice(text, kind) {
  notice.replaceChildren();
  if (!text) {
    return;
  }
  const box = document.createElement("div");
  box.className = `notice ${kind}`;
  box.textContent = text;
  notice.append(box);
}

function render(settings) {
  current = settings;
  document.getElementById("configPath").textContent = settings.configPath;
  const firstRun = !settings.configured;
  document.getElementById("heading").textContent = firstRun ? "初期設定" : "設定";
  document.getElementById("intro").textContent = firstRun
    ? "保存先フォルダを指定すると使い始められます。設定はここに表示されたファイルに保存されます。"
    : "変更は保存時にすぐ反映されます(ポートのみ再起動後)。";
  document.getElementById("backLink").hidden = firstRun;
  for (const stale of document.querySelectorAll(".hint.env")) {
    stale.remove();
  }
  if (settings.lastError) {
    setNotice(`前回の保存先フォルダを開けなかったため、未設定の状態で起動しています: ${settings.lastError}`, "broken");
  }
  for (const key of FIELDS) {
    const el = input(key);
    const value = settings.values[key];
    if (key === "openAfterSave") {
      el.checked = Boolean(value);
    } else {
      el.value = value ?? "";
    }
    const fromEnv = settings.sources[key] === "env";
    el.disabled = fromEnv;
    const hint = document.querySelector(`[data-hint="${key}"]`);
    if (fromEnv) {
      const envNote = document.createElement("div");
      envNote.className = "hint env";
      envNote.textContent = `環境変数 ${ENV_NAMES[key]} で指定されているため、ここでは変更できません。`;
      (hint ?? el.closest(".field")).after(envNote);
    }
  }
}

function collect() {
  const body = {};
  for (const key of FIELDS) {
    const el = input(key);
    if (el.disabled) {
      continue;
    }
    if (key === "openAfterSave") {
      body[key] = el.checked;
    } else if (key === "port") {
      body[key] = Number(el.value);
    } else {
      body[key] = el.value;
    }
  }
  return body;
}

async function load() {
  const res = await fetch("/api/settings");
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  render(await res.json());
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const wasUnconfigured = !current?.configured;
  saveStatus.textContent = "保存中…";
  setNotice("");
  try {
    const res = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(collect()) });
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) {
      saveStatus.textContent = "";
      setNotice(`保存できませんでした: ${body.error}`, "broken");
      return;
    }
    if (wasUnconfigured && body.configured) {
      location.href = "/";
      return;
    }
    render(body);
    saveStatus.textContent = "保存しました";
    if (body.restartRequired) {
      setNotice("ポートの変更はサーバを再起動すると有効になります。", "broken");
    }
  } catch (error) {
    saveStatus.textContent = "";
    setNotice(`保存に失敗しました: ${error.message}`, "conflict");
  }
});

load().catch((error) => setNotice(`読み込みに失敗しました: ${error.message}`, "conflict"));
