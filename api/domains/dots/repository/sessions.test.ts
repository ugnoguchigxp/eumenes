import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migration, migrations } from ".";
import { createInbox } from "../service/inbox";
test("session association migration preserves existing references and allows task-specific retention", () => {
	const db = new Database(":memory:");
	try {
		db.exec(migration);
		const session = {
			threadId: "session",
			projectId: "project",
			hostId: "local",
			parentThreadId: null,
		};
		db.query("INSERT INTO dots_sessions VALUES(?,?,?)").run(
			session.threadId,
			"first",
			JSON.stringify(session),
		);
		db.exec(migrations[1]!.sql);
		db.query("INSERT INTO dots_sessions VALUES(?,?,?)").run(
			session.threadId,
			"next",
			JSON.stringify(session),
		);
		const inbox = createInbox(Date.now);
		expect(inbox.sessionsInTransaction(db, "first")).toEqual([session]);
		expect(inbox.sessionsInTransaction(db, "next")).toEqual([session]);
		db.query("DELETE FROM dots_sessions WHERE task_id=?").run("first");
		expect(
			inbox.sessionAssociationsInTransaction(db, session.threadId),
		).toEqual([{ taskId: "next", session }]);
	} finally {
		db.close();
	}
});
