import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, url TEXT, title TEXT, memo TEXT NOT NULL DEFAULT '',
  saved_at TEXT, saved_on TEXT, updated_at TEXT,
  rel_dir TEXT NOT NULL, has_html INTEGER NOT NULL, status TEXT NOT NULL,
  conflict_files TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS items_saved_at ON items(saved_at DESC);
CREATE TABLE IF NOT EXISTS item_tags (item_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (item_id, tag));
CREATE INDEX IF NOT EXISTS item_tags_tag ON item_tags(tag);
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(id UNINDEXED, title, url, memo, tags, tokenize = 'trigram');
`;

export class Store {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  upsert(item) {
    const tags = item.tags ?? [];
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`INSERT INTO items (id, url, title, memo, saved_at, saved_on, updated_at, rel_dir, has_html, status, conflict_files)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET url = excluded.url, title = excluded.title, memo = excluded.memo, saved_at = excluded.saved_at,
          saved_on = excluded.saved_on, updated_at = excluded.updated_at, rel_dir = excluded.rel_dir, has_html = excluded.has_html,
          status = excluded.status, conflict_files = excluded.conflict_files`)
        .run(item.id, item.url ?? null, item.title ?? null, item.memo ?? "", item.savedAt ?? null, item.savedOn ?? null,
          item.updatedAt ?? null, item.relDir, item.hasHtml ? 1 : 0, item.status, JSON.stringify(item.conflictFiles ?? []));
      this.db.prepare("DELETE FROM item_tags WHERE item_id = ?").run(item.id);
      const insertTag = this.db.prepare("INSERT INTO item_tags (item_id, tag) VALUES (?, ?)");
      for (const tag of tags) {
        insertTag.run(item.id, tag);
      }
      this.db.prepare("DELETE FROM items_fts WHERE id = ?").run(item.id);
      this.db.prepare("INSERT INTO items_fts (id, title, url, memo, tags) VALUES (?, ?, ?, ?, ?)")
        .run(item.id, item.title ?? "", item.url ?? "", item.memo ?? "", tags.join(" "));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  remove(id) {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM items WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM item_tags WHERE item_id = ?").run(id);
      this.db.prepare("DELETE FROM items_fts WHERE id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  get(id) {
    const row = this.db.prepare("SELECT * FROM items WHERE id = ?").get(id);
    return row ? this.#hydrate(row) : null;
  }

  list({ q = "", tag = "", status = "", page = 1, limit = 50 } = {}) {
    const where = [];
    const params = [];
    if (q) {
      if ([...q].length >= 3) {
        where.push("items.id IN (SELECT id FROM items_fts WHERE items_fts MATCH ?)");
        params.push("\"" + q.replace(/"/g, "\"\"") + "\"");
      } else {
        where.push("items.id IN (SELECT id FROM items_fts WHERE title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' OR memo LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')");
        const like = "%" + q.replace(/[%_\\]/g, "\\$&") + "%";
        params.push(like, like, like, like);
      }
    }
    if (tag === "-") {
      where.push("NOT EXISTS (SELECT 1 FROM item_tags WHERE item_tags.item_id = items.id)");
    } else if (tag) {
      where.push("EXISTS (SELECT 1 FROM item_tags WHERE item_tags.item_id = items.id AND item_tags.tag = ?)");
      params.push(tag);
    }
    if (status) {
      where.push("items.status = ?");
      params.push(status);
    }
    const clause = where.length ? " WHERE " + where.join(" AND ") : "";
    const total = this.db.prepare("SELECT COUNT(*) AS n FROM items" + clause).get(...params).n;
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    const safePage = Math.max(1, Number(page) || 1);
    const rows = this.db.prepare("SELECT * FROM items" + clause + " ORDER BY saved_at DESC, id DESC LIMIT ? OFFSET ?")
      .all(...params, safeLimit, (safePage - 1) * safeLimit);
    return { items: rows.map((row) => this.#hydrate(row)), total, page: safePage, limit: safeLimit };
  }

  tags() {
    return this.db.prepare("SELECT tag, COUNT(*) AS count FROM item_tags GROUP BY tag ORDER BY count DESC, tag ASC").all()
      .map((row) => ({ tag: row.tag, count: row.count }));
  }

  clear() {
    this.db.exec("DELETE FROM items; DELETE FROM item_tags; DELETE FROM items_fts;");
  }

  close() {
    this.db.close();
  }

  #hydrate(row) {
    const tags = this.db.prepare("SELECT tag FROM item_tags WHERE item_id = ? ORDER BY rowid").all(row.id).map((r) => r.tag);
    return {
      id: row.id, url: row.url, title: row.title, memo: row.memo, savedAt: row.saved_at, savedOn: row.saved_on,
      updatedAt: row.updated_at, relDir: row.rel_dir, hasHtml: row.has_html === 1, status: row.status,
      tags, conflictFiles: JSON.parse(row.conflict_files)
    };
  }
}
