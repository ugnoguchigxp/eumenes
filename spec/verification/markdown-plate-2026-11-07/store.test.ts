import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./store";

test("existing doc.edit changes any uniquely named range, preserving all other Markdown bytes", () => {
	const s = openStore(":memory:");
	try {
		const original = '---\r\ntitle: memo\r\n---\r\n\r\n# 企画\r\n\r\n段落の前半。\r\n\r\n- [x] 準備\r\n';
		s.create(original);
		for (const [old, next] of [["# 企画", "# 新企画"], ["段落の前半。", "短い段落。"], ["- [x] 準備", "- [ ] 準備"]]) {
			const before = s.read()!;
			expect(s.ai("doc.edit", { baseRevision: before.revision, edits: [{ old, new: next }] })).toMatchObject({ ok: true, revision: before.revision + 1 });
			expect(s.read()!.text).toBe(before.text.replace(old!, next!));
		}
	} finally { s.close(); }
});

test("a user save during AI generation refuses the stale AI edit without overwriting the user", () => {
	const s = openStore(":memory:");
	try {
		s.create("前の段落\n\n後の段落\n");
		const base = s.read()!;
		s.commit(base.revision, "利用者が変更\n\n後の段落\n");
		expect(s.ai("doc.edit", { baseRevision: base.revision, edits: [{ old: "後の段落", new: "AIが変更" }] })).toMatchObject({ ok: false, error: "revision_conflict", revision: 2 });
		expect(s.read()!.text).toBe("利用者が変更\n\n後の段落\n");
		expect(s.history()).toHaveLength(2);
		expect(s.ai("doc.edit", { baseRevision: 2, edits: [{ old: "後の段落", new: "AIが変更" }] })).toMatchObject({ ok: true, revision: 3 });
		expect(s.read()!.text).toBe("利用者が変更\n\nAIが変更\n");
	} finally { s.close(); }
});

test("nonunique ranges and a later missing replacement leave the whole document unchanged", () => {
	const s = openStore(":memory:");
	try {
		s.create("同じ\n同じ\n独立\n");
		expect(s.ai("doc.edit", { baseRevision: 1, edits: [{ old: "同じ", new: "変更" }] })).toMatchObject({ ok: false });
		expect(s.ai("doc.edit", { baseRevision: 1, edits: [{ old: "独立", new: "変更" }, { old: "見つからない", new: "変更" }] })).toMatchObject({ ok: false });
		expect(s.read()).toMatchObject({ revision: 1, text: "同じ\n同じ\n独立\n" });
	} finally { s.close(); }
});

test("doc.write creates plain Markdown including empty text without JSON quoting", () => {
	const s = openStore(":memory:");
	try {
		s.create("初稿");
		expect(s.ai("doc.write", { baseRevision: 1, title: "全文.md", content: "# 見出し\n\n全文を更新。\n" })).toMatchObject({ ok: true });
		expect(s.read()!.text).toBe("# 見出し\n\n全文を更新。\n");
		expect(s.ai("doc.write", { baseRevision: 2, title: "空.md", content: "" })).toMatchObject({ ok: true });
		expect(s.read()!.text).toBe("");
	} finally { s.close(); }
});

test("SQLite reopen retains exact UTF8/CRLF Markdown and history; restore creates a new revision", () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-plate-lab-"));
	const path = join(dir, "lab.sqlite3");
	let s = openStore(path);
	try {
		const text = "# 保存\r\n\r\n👩‍💻 と é\r\n";
		s.create(text);
		s.commit(1, "変更後");
		s.close(); s = openStore(path);
		expect(s.read()).toMatchObject({ revision: 2, text: "変更後" });
		s.restore(2, 1);
		expect(s.read()).toMatchObject({ revision: 3, text });
		expect(s.history()).toHaveLength(3);
		expect(() => s.restore(2, 1)).toThrow("revision_conflict");
	} finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("failed persistence does not advance a revision or report success", () => {
	const s = openStore(":memory:");
	try {
		s.create("保持する本文");
		s.db.exec("PRAGMA query_only=ON");
		expect(() => s.commit(1, "保存不能")).toThrow();
		expect(s.read()).toMatchObject({ revision: 1, text: "保持する本文" });
		expect(s.history()).toHaveLength(1);
	} finally { s.close(); }
});
