import { expect, test } from "bun:test";
import {
	insertWork,
	updateWork,
	archiveWork,
	workPage,
} from "../repository/work";
import { openDialogueStore, removeDialogueStore } from "./store.fixture";

test("the archive read returns only the latest 20 by archive time and leaves them out of the active page", async () => {
	const { store, dir } = openDialogueStore("eumenes-todo-screen-");
	try {
		await store.write((db) => {
			for (let n = 0; n < 25; n++) {
				const id = `work-${String(n).padStart(2, "0")}`;
				const at = new Date(Date.UTC(2026, 9, 27, 0, n)).toISOString();
				insertWork(db, {
					id,
					conversationId: "main",
					runId: `run-${n}`,
					toolchainId: "test",
					toolchainRevisionId: "toolchain:test@1",
					execution: "task",
					request: id,
					title: id,
					sourceRef: null,
					dedupeKey: id,
					createdAt: at,
					messageIds: [],
				});
				expect(
					updateWork(db, id, 1, { status: "done", outcome: "succeeded" }, at),
				).toBe(true);
				// Reverse the creation order: the archive must follow when it was archived.
				archiveWork(
					db,
					id,
					new Date(Date.UTC(2026, 9, 27, 1, 25 - n)).toISOString(),
				);
			}
		});
		store.read((db) => {
			const page = workPage(db, "main", {
				state: "archived",
				pageIndex: 0,
				pageSize: 20,
			});
			expect(page.total).toBe(25);
			expect(page.rows.map((row) => row.id)).toEqual(
				Array.from(
					{ length: 20 },
					(_, n) => `work-${String(n).padStart(2, "0")}`,
				),
			);
			expect(
				workPage(db, "main", { state: "active", pageIndex: 0, pageSize: 10 })
					.rows,
			).toEqual([]);
			expect(
				workPage(db, "other", { state: "archived", pageIndex: 0, pageSize: 20 })
					.rows,
			).toEqual([]);
		});
	} finally {
		await store.close();
		removeDialogueStore(dir);
	}
});
