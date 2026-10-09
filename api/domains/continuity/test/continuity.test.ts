import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createContinuityService, migration } from "..";

test("goals, decisions and open questions persist across restart and track revisions", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-continuity-"));
	const file = join(dir, "db.sqlite3");
	try {
		const store = openStore(file, [migration]);
		const service = createContinuityService(store);
		const goal = await service.add("c1", { kind: "goal", text: "Rust移行" });
		await service.add("c1", { kind: "open_question", text: "CIはどうする" });
		await service.add("c2", { kind: "decision", text: "別の会話" });
		expect(service.list("c1").map((i) => i.kind)).toEqual([
			"goal",
			"open_question",
		]);
		const before = store.read((db) =>
			service.snapshotInTransaction(db, "c1"),
		).revision;
		const closed = await service.transition(goal.id, {
			expectedRevision: 1,
			status: "resolved",
		});
		expect(closed).toMatchObject({ status: "resolved", revision: 2 });
		await expect(
			service.transition(goal.id, { expectedRevision: 1, status: "retracted" }),
		).rejects.toThrow("revision_conflict");
		expect(service.list("c1").map((i) => i.id)).not.toContain(goal.id);
		expect(service.list("c1", true)).toHaveLength(2);
		expect(
			store.read((db) => service.snapshotInTransaction(db, "c1")).revision,
		).toBe(before + 1);
		await store.close();
		const reopened = openStore(file, [migration]);
		expect(createContinuityService(reopened).list("c1")).toHaveLength(1);
		await reopened.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
