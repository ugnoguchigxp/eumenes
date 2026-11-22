import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { DialogueDeps } from "../service/context";
import {
	STATE_LIMITS,
	stateLinesInTransaction,
	stateProjectionInTransaction,
} from "../service/state-text";

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

test("routing gets visible ledger references in display order, independently of titles, labels, links and prose", () => {
	const deps = depsOf(true, []);
	const open = Array.from({ length: STATE_LIMITS.work }, (_, i) => ({
		id: `work-${i + 1}`,
		ref: i + 1,
		status: "todo" as const,
		title: "t95 の再確認 (job-a314-01)",
		links: [
			{
				uri: i === STATE_LIMITS.work - 1 ? "hidden" : "song",
				label: "朝の曲 a9",
			},
		],
	}));
	Object.assign(deps.work!, {
		todosInTransaction: () => open,
		pendingConfirmationsInTransaction: () => [
			{ ref: 1, toolchain: "notes", request: "a17", impact: "none" },
		],
	});
	const state = stateProjectionInTransaction(deps, {} as Database, {
		conversationId: "main",
		nowMs,
		lastAt: null,
		lastAgent: null,
		state: {
			body: { ...keeperState.body, open: [{ text: "t97 a18" }] },
		} as never,
		refs: { ...refs, resource: (uri) => (uri === "song" ? "a3" : "a20") },
		run: { sourceKind: "scheduled" } as never,
		screenLines: [
			{ text: "- a4 画像「図 a11」", resource: "a4" },
			{ text: "- a3（直前の返事で示した）", resource: "a3" },
			{ text: "- 画面「a7」" },
			{
				text: "- [設計書](eumenes://documents/30000000-a314-4000-8000-000000000001)",
			},
			{ text: "- a5（表示枠外）", resource: "a5" },
		],
	});
	expect(state.lines.join("\n")).toContain("実行中 a3「朝の曲 a9」");
	expect(state.lines).toContain("- t97 a18");
	expect(state.lines.join("\n")).not.toContain("表示枠外");
	expect(state.resources).toEqual(["a3", "a4"]);
	expect(state.todos).toEqual(
		open.slice(0, STATE_LIMITS.work - 1).map(({ ref }) => ref),
	);
});
