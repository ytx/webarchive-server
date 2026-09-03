import { t } from "./i18n.js";
import { initUi } from "./ui.js";

initUi();

const state = { q: "", tag: "", status: "", page: 1, limit: 50 };
const qInput = document.getElementById("q");
const listEl = document.getElementById("list");

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  state.q = params.get("q") ?? "";
  state.tag = params.get("tag") ?? "";
  state.status = params.get("status") ?? "";
  state.page = Number(params.get("page") ?? 1) || 1;
  qInput.value = state.q;
}

function writeHash() {
  const params = new URLSearchParams();
  for (const key of ["q", "tag", "status"]) {
    if (state[key]) {
      params.set(key, state[key]);
    }
  }
  if (state.page > 1) {
    params.set("page", String(state.page));
  }
  history.replaceState(null, "", "#" + params.toString());
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") {
      node.className = value;
    } else if (key === "href") {
      node.setAttribute("href", value);
    } else {
      node[key] = value;
    }
  }
  for (const child of children) {
    node.append(child);
  }
  return node;
}

function domain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url ?? "";
  }
}

function openInNewTabLink(href) {
  const link = el("a", { class: "open", href, title: t("list.openNewTab") });
  link.setAttribute("target", "_blank");
  link.setAttribute("rel", "noopener");
  link.setAttribute("aria-label", t("list.openNewTab"));
  link.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h4v4"/><path d="M13 3 7 9"/><path d="M11 9v3.5a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5v-7a.5.5 0 0 1 .5-.5H7"/></svg>';
  return link;
}

function filterLink(label, count, active, patch, extraClass = "") {
  const link = el("a", { class: `filter ${active ? "active" : ""} ${extraClass}`.trim(), href: "#" }, [el("span", {}, [label]), el("span", {}, [String(count)])]);
  link.addEventListener("click", (event) => {
    event.preventDefault();
    Object.assign(state, patch, { page: 1 });
    load();
  });
  return link;
}

async function load() {
  writeHash();
  const params = new URLSearchParams({ q: state.q, tag: state.tag, status: state.status, page: String(state.page), limit: String(state.limit) });
  const [result, tags, all, untagged, conflicts] = await Promise.all([
    fetch("/api/items?" + params).then((r) => r.json()),
    fetch("/api/tags").then((r) => r.json()),
    fetch("/api/items?limit=1").then((r) => r.json()),
    fetch("/api/items?limit=1&tag=-").then((r) => r.json()),
    fetch("/api/items?limit=1&status=conflict").then((r) => r.json())
  ]);
  renderSide(tags, all.total, untagged.total, conflicts.total);
  renderList(result);
}

function renderSide(tags, total, untagged, conflicts) {
  const statusNav = document.getElementById("statusNav");
  statusNav.replaceChildren(
    filterLink(t("list.all"), total, !state.tag && !state.status, { tag: "", status: "" }),
    filterLink(t("list.untagged"), untagged, state.tag === "-", { tag: "-", status: "" }),
    filterLink(t("list.conflicts"), conflicts, state.status === "conflict", { tag: "", status: "conflict" }, "danger")
  );
  const tagNav = document.getElementById("tagNav");
  tagNav.replaceChildren(...tags.map(({ tag, count }) => filterLink(tag, count, state.tag === tag, { tag, status: "" })));
  document.getElementById("summary").textContent = t("list.items", { n: total.toLocaleString() });
}

function renderList({ items, total, page, limit }) {
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(total, page * limit);
  document.getElementById("range").textContent = `${from}–${to} / ${total}`;
  document.getElementById("prev").style.visibility = page > 1 ? "visible" : "hidden";
  document.getElementById("next").style.visibility = to < total ? "visible" : "hidden";
  if (items.length === 0) {
    listEl.replaceChildren(el("div", { class: "empty" }, [t("list.empty")]));
    return;
  }
  listEl.replaceChildren(...items.map((item) => {
    const title = el("div", { class: "title" });
    if (item.status === "conflict") {
      title.append(el("span", { class: "badge" }, [t("badge.conflict")]));
    } else if (item.status === "pending") {
      title.append(el("span", { class: "badge pending" }, [t("badge.pending")]));
    } else if (item.status === "broken") {
      title.append(el("span", { class: "badge" }, [t("badge.broken")]));
    }
    title.append(item.title || item.url || item.id);
    const subText = [domain(item.url), item.memo ? item.memo.split("\n")[0] : ""].filter(Boolean).join(" · ");
    const chips = el("div", { class: "chips" }, item.tags.length
      ? item.tags.map((tag) => el("span", { class: "chip" }, [tag]))
      : [el("span", { class: "chip none" }, [t("chip.none")])]);
    const main = el("a", { class: "main", href: `/items/${item.id}` }, [
      el("div", { style: "min-width:0; display:flex; flex-direction:column; gap:3px;" }, [title, el("div", { class: "sub" }, [subText])]),
      chips,
      el("div", { class: "date" }, [(item.savedAt ?? "").slice(0, 10)])
    ]);
    const row = el("div", { class: `row ${item.status === "conflict" ? "conflict" : ""}`.trim() }, [main]);
    if (item.hasHtml) {
      row.append(openInNewTabLink(`/items/${item.id}/page`));
    } else {
      row.append(el("span", { class: "open placeholder" }));
    }
    return row;
  }));
}

document.getElementById("searchForm").addEventListener("submit", (event) => {
  event.preventDefault();
  state.q = qInput.value.trim();
  state.page = 1;
  load();
});
document.getElementById("prev").addEventListener("click", (event) => { event.preventDefault(); state.page--; load(); });
document.getElementById("next").addEventListener("click", (event) => { event.preventDefault(); state.page++; load(); });
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && document.activeElement !== qInput) {
    event.preventDefault();
    qInput.focus();
  }
});

readHash();
load().catch((error) => {
  listEl.replaceChildren(el("div", { class: "empty" }, [t("list.loadFailed", { message: error.message })]));
});
