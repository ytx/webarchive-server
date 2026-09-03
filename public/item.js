import { t } from "./i18n.js";
import { initUi, allowNavigation } from "./ui.js";

initUi();

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

function setStatus(text, kind) {
  saveStatus.querySelector(".dot").className = `dot ${kind}`;
  saveStatus.querySelector("span:last-child").textContent = text;
}

// Only ever put item.url into an href when it actually parses as an http(s)
// URL. A hand-edited or repaired sidecar could carry anything (javascript:,
// data:, garbage text); render that as plain text instead and leave the
// link buttons inert.
function safeHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

async function load() {
  [item, allTags] = await Promise.all([api(`/api/items/${id}`), api("/api/tags")]);
  tags = [...item.tags];
  document.title = `${item.title ?? item.id} – WebArchive`;
  document.getElementById("title").textContent = item.title ?? t("item.noTitle");
  const urlEl = document.getElementById("url");
  const safeUrl = safeHttpUrl(item.url);
  urlEl.textContent = item.url ?? "";
  urlEl.href = safeUrl ?? "#";
  document.getElementById("openOriginal").href = safeUrl ?? "#";
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
    box.textContent = t("item.conflict");
    box.append(choice(t("item.conflictMain"), item.memo, item.tags, "main", true));
    for (const conflict of item.conflicts) {
      // A conflict copy whose json is itself broken (memo === null) can't be
      // adopted: the server would 400 on resolve. Show it read-only instead
      // of offering a button that always fails.
      box.append(choice(conflict.file, conflict.memo ?? t("item.unreadable"), conflict.tags, `conflict:${conflict.file}`, conflict.memo !== null));
    }
    notice.append(box);
  } else if (item.status === "broken") {
    const box = document.createElement("div");
    box.className = "notice broken";
    box.textContent = t("item.broken");
    const url = Object.assign(document.createElement("input"), { placeholder: t("item.brokenUrl"), style: "width:100%; margin-top:6px;" });
    const title = Object.assign(document.createElement("input"), { placeholder: t("item.brokenTitle"), style: "width:100%; margin-top:6px;" });
    const button = Object.assign(document.createElement("button"), { className: "btn", textContent: t("item.repair"), style: "margin-top:6px;" });
    button.addEventListener("click", async () => {
      await api(`/api/items/${id}`, { method: "PATCH", body: JSON.stringify({ url: url.value, title: title.value, memo: memoEl.value, tags }) });
      await load();
    });
    box.append(url, title, button);
    notice.append(box);
  } else if (item.status === "pending") {
    const box = document.createElement("div");
    box.className = "notice broken";
    box.textContent = t("item.pending");
    notice.append(box);
  }
}

function choice(label, memo, chosenTags, choose, canAdopt = true) {
  const box = document.createElement("div");
  box.className = "choice";
  const pre = document.createElement("pre");
  pre.textContent = memo || t("item.noMemo");
  const button = Object.assign(document.createElement("button"), { className: "btn", textContent: t("item.adopt") });
  if (!canAdopt) {
    button.disabled = true;
    button.hidden = true;
  } else {
    button.addEventListener("click", async () => {
      await api(`/api/items/${id}/resolve`, { method: "POST", body: JSON.stringify({ choose }) });
      await load();
    });
  }
  box.append(Object.assign(document.createElement("div"), { textContent: label, style: "font-weight:600;" }), pre,
    Object.assign(document.createElement("div"), { textContent: chosenTags.length ? chosenTags.join(", ") : t("item.noTags"), style: "color:var(--muted); margin-bottom:6px;" }), button);
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
    const remove = Object.assign(document.createElement("button"), { textContent: "×", title: t("item.removeTag") });
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
    row.append(Object.assign(document.createElement("span"), { textContent: count === null ? t("item.newTag", { tag }) : tag }),
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
  if (item?.status === "broken") {
    // A broken sidecar has no url/title on the server yet; the repair form's
    // own button is the only path that supplies them alongside memo/tags, so
    // auto-save (blur, Cmd+S, tag edits) must not fire here.
    return;
  }
  dirty = false;
  setStatus(t("item.saving"), "muted");
  try {
    item = await api(`/api/items/${id}`, { method: "PATCH", body: JSON.stringify({ memo: memoEl.value, tags }) });
    allTags = await api("/api/tags");
    setStatus(t("item.savedAt", { time: (item.updatedAt ?? "").slice(11, 19) }), "ok");
  } catch (error) {
    setStatus(t("item.saveFailed", { message: error.message }), "danger");
  }
}

memoEl.addEventListener("input", () => { dirty = true; setStatus(t("item.unsaved"), "muted"); });
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
  if (window.confirm(t("item.deleteConfirm"))) {
    await api(`/api/items/${id}`, { method: "DELETE" });
    allowNavigation();
    location.href = "/";
  }
});
window.addEventListener("beforeunload", (event) => {
  if (dirty) {
    event.preventDefault();
  }
});

load().catch((error) => {
  document.getElementById("notice").textContent = t("item.loadFailed", { message: error.message });
});
