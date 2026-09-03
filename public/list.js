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
    filterLink("すべて", total, !state.tag && !state.status, { tag: "", status: "" }),
    filterLink("タグなし", untagged, state.tag === "-", { tag: "-", status: "" }),
    filterLink("競合あり", conflicts, state.status === "conflict", { tag: "", status: "conflict" }, "danger")
  );
  const tagNav = document.getElementById("tagNav");
  tagNav.replaceChildren(...tags.map(({ tag, count }) => filterLink(tag, count, state.tag === tag, { tag, status: "" })));
  document.getElementById("summary").textContent = `${total.toLocaleString()} items`;
}

function renderList({ items, total, page, limit }) {
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(total, page * limit);
  document.getElementById("range").textContent = `${from}–${to} / ${total}`;
  document.getElementById("prev").style.visibility = page > 1 ? "visible" : "hidden";
  document.getElementById("next").style.visibility = to < total ? "visible" : "hidden";
  if (items.length === 0) {
    listEl.replaceChildren(el("div", { class: "empty" }, ["該当する項目はありません"]));
    return;
  }
  listEl.replaceChildren(...items.map((item) => {
    const title = el("div", { class: "title" });
    if (item.status === "conflict") {
      title.append(el("span", { class: "badge" }, ["競合"]));
    } else if (item.status === "pending") {
      title.append(el("span", { class: "badge pending" }, ["同期中"]));
    } else if (item.status === "broken") {
      title.append(el("span", { class: "badge" }, ["要修復"]));
    }
    title.append(item.title || item.url || item.id);
    const subText = [domain(item.url), item.memo ? item.memo.split("\n")[0] : ""].filter(Boolean).join(" · ");
    const chips = el("div", { class: "chips" }, item.tags.length
      ? item.tags.map((tag) => el("span", { class: "chip" }, [tag]))
      : [el("span", { class: "chip none" }, ["タグなし"])]);
    return el("a", { class: `row ${item.status === "conflict" ? "conflict" : ""}`, href: `/items/${item.id}` }, [
      el("div", { style: "min-width:0; display:flex; flex-direction:column; gap:3px;" }, [title, el("div", { class: "sub" }, [subText])]),
      chips,
      el("div", { class: "date" }, [(item.savedAt ?? "").slice(0, 10)])
    ]);
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
  listEl.replaceChildren(el("div", { class: "empty" }, [`読み込みに失敗しました: ${error.message}`]));
});
