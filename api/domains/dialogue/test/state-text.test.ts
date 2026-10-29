import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { DialogueDeps } from "../service/context";
import { STATE_LIMITS, stateLinesInTransaction } from "../service/state-text";

/**
 * `## State` keeps nothing of the conversation before the recent one (the review fixes design, C4 and C5): finished
 * work from before it is left out, and the context keeper's fields show only while the keeper runs.
 */
const nowMs = Date.parse("2026-10-29T14:50:00.000Z");
const refs = {
	todo: () => null,
	confirmation: () => null,
	resource: () => null,
};
const keeperState = {
	body: {
		topic: "火曜の夜の音楽",
		decisions: [{ text: "プレイリストを作る" }],
		open: [],
		records: [],
	},
};

function depsOf(keeper: boolean, archivedSince: string[]) {
	return {
		work: {
			todosInTransaction: () => [],
			pendingConfirmationsInTransaction: () => [],
			recentlyArchivedInTransaction: (
				_db: unknown,
				_id: string,
				since: string,
			) => {
				archivedSince.push(since);
				return [];
			},
		},
		...(keeper ? { contextKeeper: {} } : {}),
	} as unknown as DialogueDeps;
}

const lines = (deps: DialogueDeps, since: number | null) =>
	stateLinesInTransaction(deps, {} as Database, {
		conversationId: "main",
		nowMs,
		lastAt: null,
		since,
		lastAgent: null,
		state: keeperState as never,
		refs,
	});

test("finished work is shown from the start of the recent conversation, within its usual window", () => {
	const since: string[] = [];
	const clearedAt = nowMs - 5 * 60 * 1000;
	lines(depsOf(false, since), clearedAt);
	lines(depsOf(false, since), null);
	expect(since).toEqual([
		new Date(clearedAt).toISOString(),
		new Date(nowMs - STATE_LIMITS.archivedMs).toISOString(),
	]);
});

test("the context keeper's fields show only while it runs", () => {
	expect(lines(depsOf(false, []), null).join("\n")).not.toContain("火曜の夜");
	expect(lines(depsOf(true, []), null)).toContain("話題: 火曜の夜の音楽");
});
