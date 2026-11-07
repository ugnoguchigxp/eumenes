/** Experimental owner adapter only. Never opens or migrates the product database. */
import { Database } from "bun:sqlite";
import type { SpecialistDocument } from "../../../api/domains/dialogue/contracts/specialist";
import { runDocTool, type DocToolId } from "../../../api/domains/dialogue/service/specialist-agent";

export function openStore(path: string) {
	const db = new Database(path, { create: true });
	db.exec("CREATE TABLE IF NOT EXISTS lab_documents(id TEXT PRIMARY KEY,title TEXT NOT NULL,text TEXT NOT NULL,revision INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS lab_history(id TEXT NOT NULL,revision INTEGER NOT NULL,title TEXT NOT NULL,text TEXT NOT NULL,actor TEXT NOT NULL,PRIMARY KEY(id,revision));");
	function read(id = "document") {
		const row = db.query("SELECT title,text,revision FROM lab_documents WHERE id=?").get(id) as { title: string; text: string; revision: number } | null;
		return row ? { ...row, rejected: null } : null;
	}
	function create(text: string, title = "検証.md") {
		db.transaction(() => {
			db.query("INSERT INTO lab_documents VALUES(?,?,?,1)").run("document", title, text);
			db.query("INSERT INTO lab_history VALUES(?,1,?,?,?)").run("document", title, text, "user");
		})();
		return read()!;
	}
	function commit(baseRevision: number, text: string, title?: string, actor = "user") {
		return db.transaction(() => {
			const current = read();
			if (!current || current.revision !== baseRevision) throw new Error("revision_conflict");
			const revision = current.revision + 1;
			const updated = db.query("UPDATE lab_documents SET text=?,title=?,revision=? WHERE id=? AND revision=?").run(text, title ?? current.title, revision, "document", baseRevision);
			if (updated.changes !== 1) throw new Error("revision_conflict");
			db.query("INSERT INTO lab_history VALUES(?,?,?,?,?)").run("document", revision, title ?? current.title, text, actor);
			return { revision };
		})();
	}
	const document: SpecialistDocument = {
		readInTransaction: (_db, workRef) => read(workRef),
		check: text => ({ ok: true, value: text, fixes: [] }),
		commitInTransaction: (_db, _workRef, input) => {
			if (typeof input.value !== "string") throw new Error("text_required");
			return commit(input.baseRevision, input.value, input.title, "collaborator-fixture");
		},
		rejectInTransaction: () => { throw new Error("text_check_never_rejects"); },
	};
	function ai(tool: DocToolId, args: unknown) {
		return db.transaction(() => runDocTool(db, document, tool, args, { workRef: "document", sessionId: "lab-session", runId: "lab-run", conversationId: "lab-conversation" }))();
	}
	function history() { return db.query("SELECT revision,title,text,actor FROM lab_history WHERE id=? ORDER BY revision").all("document"); }
	function restore(baseRevision: number, revision: number) {
		const row = db.query("SELECT text,title FROM lab_history WHERE id=? AND revision=?").get("document", revision) as { text: string; title: string } | null;
		if (!row) throw new Error("revision_missing");
		return commit(baseRevision, row.text, row.title, "restore");
	}
	return { db, read, create, commit, ai, history, restore, close: () => db.close() };
}
