import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

// 验证 0005_purge_non_http_bookmarks 迁移 SQL 的语义:
// 删除存量非 http(s) 书签,并清掉因此失去引用的孤儿标签(外键级联 + 孤儿清理)
function setupDb() {
	const sqlite = new Database(":memory:");
	sqlite.pragma("foreign_keys = ON");
	sqlite.exec(`
		CREATE TABLE bookmarks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			title TEXT NOT NULL,
			url TEXT NOT NULL,
			category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL
		);
		CREATE TABLE categories (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL,
			parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE
		);
		CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
		CREATE TABLE bookmark_tags (
			bookmark_id INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
			tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
			PRIMARY KEY (bookmark_id, tag_id)
		);
	`);
	return sqlite;
}

const PURGE_SQL = `
	DELETE FROM bookmarks WHERE url NOT LIKE 'http://%' AND url NOT LIKE 'https://%';
	DELETE FROM tags WHERE NOT EXISTS (
		SELECT 1 FROM bookmark_tags WHERE bookmark_tags.tag_id = tags.id
	);
`;

describe("0005 迁移:清理非 http(s) 存量书签", () => {
	let db: ReturnType<typeof setupDb>;
	beforeEach(() => {
		db = setupDb();
	});

	it("删除 javascript:/data: 等危险协议书签,保留 http(s)", () => {
		const ins = db.prepare("INSERT INTO bookmarks (title, url) VALUES (?, ?)");
		ins.run("js", "javascript:alert(1)");
		ins.run("data", "data:text/html,x");
		ins.run("file", "file:///etc/passwd");
		ins.run("ok1", "https://example.com");
		ins.run("ok2", "http://example.com/a");

		db.exec(PURGE_SQL);

		const urls = (db.prepare("SELECT url FROM bookmarks").all() as { url: string }[]).map(
			(r) => r.url,
		);
		expect(urls.sort()).toEqual(["http://example.com/a", "https://example.com"]);
	});

	it("被删书签的标签关联级联消失,失去引用的孤儿标签被清理,仍在使用的标签保留", () => {
		const insBm = db.prepare("INSERT INTO bookmarks (title, url) VALUES (?, ?)");
		const insTag = db.prepare("INSERT INTO tags (name) VALUES (?)");
		const insLink = db.prepare("INSERT INTO bookmark_tags (bookmark_id, tag_id) VALUES (?, ?)");
		const bad = insBm.run("bad", "javascript:x").lastInsertRowid as number;
		const good = insBm.run("good", "https://a.com").lastInsertRowid as number;
		// orphan:只挂在将被删除的书签上;shared:同时挂在坏书签和好书签上
		const orphan = insTag.run("orphan").lastInsertRowid as number;
		const shared = insTag.run("shared").lastInsertRowid as number;
		const unused = insTag.run("unused").lastInsertRowid as number;
		insLink.run(bad, orphan);
		insLink.run(bad, shared);
		insLink.run(good, shared);

		db.exec(PURGE_SQL);

		const names = (
			db.prepare("SELECT name FROM tags").all() as { name: string }[]
		).map((r) => r.name);
		// shared 仍被好书签引用 → 保留;orphan 因坏书签删除而失引 → 清理;unused 本就无引用 → 清理
		expect(names).toEqual(["shared"]);
		expect(db.prepare("SELECT count(*) c FROM bookmarks").get()).toEqual({ c: 1 });
		expect(
			(db.prepare("SELECT count(*) c FROM bookmark_tags").get() as { c: number }).c,
		).toBe(1);
		void unused;
	});
});
