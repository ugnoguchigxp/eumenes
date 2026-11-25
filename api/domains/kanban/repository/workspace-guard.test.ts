import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrations } from "./migrations";
import {
	beginWorkspaceReleaseInTransaction,
	finishWorkspaceReleaseInTransaction,
	readWorkspaceGuard,
	readWorkspaceGuards,
	recoverWorkspaceReleaseInTransaction,
	reserveWorkspaceInTransaction,
	type WorkspaceGuard,
} from "./workspace-guard";

test("workspace migration preserves quarantined legacy holders and only allows one read and one edit in either order", () => {
	const db = new Database(":memory:");
	try {
		const holders = migrations.findIndex(
			(m) => m.id === "kanban/0006-workspace-holders",
		);
		for (const migration of migrations.slice(0, holders))
			db.exec(migration.sql!);
		db.query("INSERT INTO kanban_workspace_guards VALUES(?,?,?,?,?)").run(
			"legacy",
			"owner",
			"executor",
			"epoch",
			"unknown",
		);
		db.exec(migrations[holders]!.sql!);
		const legacy = readWorkspaceGuards(db, "legacy");
		expect(legacy).toEqual([
			{
				workspaceRef: "legacy",
				ownerRef: "owner",
				executorId: "executor",
				epoch: "epoch",
				mode: "exclusive",
				state: "unknown",
			},
		]);
		const reader = {
			...legacy[0]!,
			workspaceRef: "here",
			mode: "read",
			ownerRef: "reader",
			epoch: "read-epoch",
			state: "held",
		} satisfies WorkspaceGuard;
		const editor = {
			...reader,
			mode: "edit",
			ownerRef: "editor",
			epoch: "edit-epoch",
		} satisfies WorkspaceGuard;
		expect(
			reserveWorkspaceInTransaction(db, { ...reader, workspaceRef: "legacy" }),
		).toBe(false);
		expect(
			recoverWorkspaceReleaseInTransaction(db, { ...legacy[0]!, epoch: "old" }),
		).toBe(false);
		expect(recoverWorkspaceReleaseInTransaction(db, legacy[0]!)).toBe(true);
		for (const pair of [
			[reader, editor],
			[editor, reader],
		]) {
			for (const guard of pair)
				expect(reserveWorkspaceInTransaction(db, guard)).toBe(true);
			expect(readWorkspaceGuard(db, "here", reader)).toEqual(reader);
			expect(readWorkspaceGuards(db, "here")).toHaveLength(2);
			expect(reserveWorkspaceInTransaction(db, reader)).toBe(true);
			expect(
				reserveWorkspaceInTransaction(db, { ...reader, mode: "edit" }),
			).toBe(false);
			expect(
				reserveWorkspaceInTransaction(db, { ...editor, ownerRef: "extra" }),
			).toBe(false);
			expect(
				reserveWorkspaceInTransaction(db, {
					...editor,
					ownerRef: "legacy",
					mode: "exclusive",
				}),
			).toBe(false);
			expect(beginWorkspaceReleaseInTransaction(db, reader)).toBe(true);
			expect(
				finishWorkspaceReleaseInTransaction(
					db,
					{ ...reader, epoch: "old" },
					true,
				),
			).toBe(false);
			expect(finishWorkspaceReleaseInTransaction(db, reader, false)).toBe(
				false,
			);
			expect(
				reserveWorkspaceInTransaction(db, { ...reader, ownerRef: "another" }),
			).toBe(false);
			expect(recoverWorkspaceReleaseInTransaction(db, reader)).toBe(true);
			expect(readWorkspaceGuards(db, "here")).toEqual([editor]);
			expect(beginWorkspaceReleaseInTransaction(db, editor)).toBe(true);
			expect(finishWorkspaceReleaseInTransaction(db, editor, true)).toBe(true);
		}
	} finally {
		db.close();
	}
});
