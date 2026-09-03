const id = location.pathname.split("/").pop();
const isNew = new URLSearchParams(location.search).get("new") === "1";
const memoEl = document.getElementById("memo");
const tagInput = document.getElementById("tagInput");
const tagbox = document.getElementById("tagbox");
const saveStatus = document.getElementById("saveStatus");
let item = null;
let tags = [];
let allTags = [];
let suggestIndex = 0;
let dirty = false;

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  if (!res.ok && res.status !== 204) {
    throw new Error(`${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

function setStatus(text, color) {
  saveStatus.querySelector(".dot").style.background = color;
  saveStatus.querySelector("span:last-child").textContent = text;
}

async function load() {
  [item, allTags] = await Promise.all([api(`/api/items/${id}`), api("/api/tags")]);
  tags = [...item.tags];
  document.title = `${item.title ?? item.id} – WebArchive`;
  document.getElementById("title").textContent = item.title ?? "(タイトルなし)";
  const urlEl = document.getElementById("url");
  urlEl.textContent = item.url ?? "";
  urlEl.href = item.url ?? "#";
  document.getElementById("openOriginal").href = item.url ?? "#";
  document.getElementById("savedAt").textContent = (item.savedAt ?? "").replace("T", " ").slice(0, 16);
  document.getElementById("savedOn").textContent = item.savedOn ?? "";
  document.getElementById("download").href = `/items/${id}/page`;
  document.getElementById("download").setAttribute("download", `${item.title ?? item.id}.html`);
  document.getElementById("openPage").href = `/items/${id}/page`;
  document.getElementById("frame").src = item.hasHtml ? `/items/${id}/page` : "about:blank";
  memoEl.value = item.memo ?? "";
  renderTags();
  renderNotice();
  if (isNew) {
    memoEl.focus();
  }
}

function renderNotice() {
  const notice = document.getElementById("notice");
  notice.replaceChildren();
  if (item.status === "conflict") {
    const box = document.createElement("div");
    box.className = "notice conflict";
    box.textContent = "別のマシンで同時に編集されたため、Dropbox が競合コピーを作成しました。採用する内容を選んでください。";
    box.append(choice("このマシンの内容(現在の表示)", item.memo, item.tags, "main"));
    for (const conflict of item.conflicts) {
      box.append(choice(conflict.file, conflict.memo ?? "(読み取り不能)", conflict.tags, `conflict:${conflict.file}`));
    }
    notice.append(box);
  } else if (item.status === "broken") {
    const box = document.createElement("div");
    box.className = "notice broken";
    box.innerHTML = "メタデータ(JSON)が壊れています。URL とタイトルを入力して保存すると修復されます。<br>";
    const url = Object.assign(document.createElement("input"), { placeholder: "URL", style: "width:100%; margin-top:6px;" });
    const title = Object.assign(document.createElement("input"), { placeholder: "タイトル", style: "width:100%; margin-top:6px;" });
    const button = Object.assign(document.createElement("button"), { className: "btn", textContent: "修復して保存", style: "margin-top:6px;" });
    button.addEventListener("click", async () => {
      await api(`/api/items/${id}`, { method: "PATCH", body: JSON.stringify({ url: url.value, title: title.value, memo: memoEl.value, tags }) });
      await load();
    });
    box.append(url, title, button);
    notice.append(box);
  } else if (item.status === "pending") {
    const box = document.createElement("div");
    box.className = "notice broken";
    box.textContent = "HTML がまだ同期されていません(Dropbox の到着待ち)。";
    notice.append(box);
  }
}

function choice(label, memo, chosenTags, choose) {
  const box = document.createElement("div");
  box.className = "choice";
  const pre = document.createElement("pre");
  pre.textContent = memo || "(メモなし)";
  const button = Object.assign(document.createElement("button"), { className: "btn", textContent: "この内容を採用" });
  button.addEventListener("click", async () => {
    await api(`/api/items/${id}/resolve`, { method: "POST", body: JSON.stringify({ choose }) });
    await load();
  });
  box.append(Object.assign(document.createElement("div"), { textContent: label, style: "font-weight:600;" }), pre,
    Object.assign(document.createElement("div"), { textContent: chosenTags.length ? chosenTags.join(", ") : "(タグなし)", style: "color:#6b6b66; margin-bottom:6px;" }), button);
  return box;
}

function renderTags() {
  for (const chip of tagbox.querySelectorAll(".chip")) {
    chip.remove();
  }
  for (const tag of tags) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = tag;
    const remove = Object.assign(document.createElement("button"), { textContent: "×", title: "削除" });
    remove.addEventListener("click", () => {
      tags = tags.filter((t) => t !== tag);
      renderTags();
      save();
    });
    chip.append(remove);
    tagbox.insertBefore(chip, tagInput);
  }
}

function suggestions() {
  const text = tagInput.value.trim().toLowerCase();
  if (!text) {
    return [];
  }
  const matches = allTags.filter(({ tag }) => tag.includes(text) && !tags.includes(tag)).slice(0, 8);
  if (!matches.some(({ tag }) => tag === text) && !tags.includes(text)) {
    matches.push({ tag: text, count: null });
  }
  return matches;
}

function renderSuggest() {
  document.querySelector(".suggest")?.remove();
  const list = suggestions();
  if (list.length === 0) {
    return;
  }
  suggestIndex = Math.min(suggestIndex, list.length - 1);
  const box = document.createElement("div");
  box.className = "suggest";
  list.forEach(({ tag, count }, index) => {
    const row = document.createElement("div");
    row.className = (index === suggestIndex ? "active" : "") + (count === null ? " create" : "");
    row.append(Object.assign(document.createElement("span"), { textContent: count === null ? `新しいタグ "${tag}" を作成` : tag }),
      Object.assign(document.createElement("span"), { textContent: count === null ? "↵" : String(count) }));
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      addTag(tag);
    });
    box.append(row);
  });
  tagbox.append(box);
}

function addTag(tag) {
  tag = tag.trim().toLowerCase();
  if (tag && !tags.includes(tag)) {
    tags.push(tag);
    renderTags();
    save();
  }
  tagInput.value = "";
  suggestIndex = 0;
  renderSuggest();
}

async function save() {
  dirty = false;
  setStatus("保存中…", "#9a9a94");
  try {
    item = await api(`/api/items/${id}`, { method: "PATCH", body: JSON.stringify({ memo: memoEl.value, tags }) });
    allTags = await api("/api/tags");
    setStatus(`保存済み ${(item.updatedAt ?? "").slice(11, 19)}`, "#3a8f5c");
  } catch (error) {
    setStatus("保存に失敗: " + error.message, "#a3412c");
  }
}

memoEl.addEventListener("input", () => { dirty = true; setStatus("未保存", "#9a9a94"); });
memoEl.addEventListener("blur", () => { if (dirty) { save(); } });
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "s") {
    event.preventDefault();
    if (document.activeElement === tagInput && tagInput.value.trim()) {
      addTag(tagInput.value);
    }
    save();
  }
});
tagInput.addEventListener("input", () => { suggestIndex = 0; renderSuggest(); });
tagInput.addEventListener("blur", () => setTimeout(() => document.querySelector(".suggest")?.remove(), 100));
tagInput.addEventListener("keydown", (event) => {
  const list = suggestions();
  if (event.key === "Enter") {
    event.preventDefault();
    if (list.length) {
      addTag(list[suggestIndex].tag);
    }
  } else if (event.key === "ArrowDown" && list.length) {
    event.preventDefault();
    suggestIndex = (suggestIndex + 1) % list.length;
    renderSuggest();
  } else if (event.key === "ArrowUp" && list.length) {
    event.preventDefault();
    suggestIndex = (suggestIndex - 1 + list.length) % list.length;
    renderSuggest();
  } else if (event.key === "Backspace" && !tagInput.value && tags.length) {
    tags.pop();
    renderTags();
    save();
  } else if (event.key === "Escape") {
    tagInput.value = "";
    renderSuggest();
  }
});
document.getElementById("delete").addEventListener("click", async () => {
  if (window.confirm("この項目と保存した HTML を削除します。よろしいですか?")) {
    await api(`/api/items/${id}`, { method: "DELETE" });
    location.href = "/";
  }
});
window.addEventListener("beforeunload", (event) => {
  if (dirty) {
    event.preventDefault();
  }
});

load().catch((error) => {
  document.getElementById("notice").textContent = "読み込みに失敗しました: " + error.message;
});
