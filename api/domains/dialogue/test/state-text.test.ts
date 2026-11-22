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
 * work from before it is left out.
 */
const nowMs = Date.parse("2026-10-29T14:50:00.000Z");
const refs = {
	todo: () => null,
	confirmation: () => null,
	resource: () => null,
};
function depsOf(archivedSince: string[]) {
	return {
		work: {
			workInTransaction: () => null,
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
	} as unknown as DialogueDeps;
}

const lines = (deps: DialogueDeps, since: number | null) =>
	stateLinesInTransaction(deps, {} as Database, {
		conversationId: "main",
		nowMs,
		lastAt: null,
		since,
		lastAgent: null,
		state: null,
		refs,
	});

test("finished work is shown from the start of the recent conversation, within its usual window", () => {
	const since: string[] = [];
	const clearedAt = nowMs - 5 * 60 * 1000;
	lines(depsOf(since), clearedAt);
	lines(depsOf(since), null);
	expect(since).toEqual([
		new Date(clearedAt).toISOString(),
		new Date(nowMs - STATE_LIMITS.archivedMs).toISOString(),
	]);
});

test("routing gets visible ledger references in display order, independently of titles, labels, links and prose", () => {
	const deps = depsOf([]);
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
		state: null,
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
	expect(state.lines.join("\n")).not.toContain("表示枠外");
	expect(state.resources).toEqual(["a3", "a4"]);
	expect(state.todos).toEqual(
		open.slice(0, STATE_LIMITS.work - 1).map(({ ref }) => ref),
	);
});

/** A TODO as the ledger holds it, with the records its `## State` line is drawn from. */
function detailDeps(options: { forgotten?: string[] } = {}) {
	const rows = new Map<string, Record<string, unknown>>();
	const todos = [
		{
			id: "w1",
			ref: 1,
			status: "waiting" as const,
			title: "壁紙の作成",
			question: "どの色合いにしますか？\n暖色か寒色で",
		},
		{ id: "w2", ref: 2, status: "todo" as const, title: "旅行の下調べ" },
		{ id: "w3", ref: 3, status: "todo" as const, title: "調査（自分の）" },
		{ id: "w4", ref: 4, status: "todo" as const, title: "同じ依頼" },
	];
	rows.set("w1", {
		id: "w1",
		revision: 1,
		messageIds: [],
		runId: "r1",
		request: "夕暮れの猫の壁紙を作って".repeat(40),
		execution: "task",
		sourceRef: "exec-1",
	});
	rows.set("w2", {
		id: "w2",
		revision: 1,
		messageIds: [],
		runId: "r2",
		request: "京都の旅行を調べて",
	});
	rows.set("w4", {
		id: "w4",
		revision: 1,
		messageIds: [],
		runId: "r4",
		request: "同じ依頼",
	});
	rows.set("w3", {
		id: "w3",
		revision: 1,
		messageIds: [],
		runId: "own",
		request: "自分の関心の調査",
	});
	const deps = {
		work: {
			workInTransaction: (_tx: unknown, id: string) => rows.get(id) ?? null,
			todosInTransaction: () => todos,
			pendingConfirmationsInTransaction: () => [],
			recentlyArchivedInTransaction: () => [],
		},
		agents: {
			executions: {
				viewInTransaction: () => ({
					revision: 3,
					tasks: [
						{
							taskId: "task-a",
							revision: 1,
							title: "下絵",
							state: "running",
							reason: "構図を詰めている\n途中".repeat(80),
						},
					],
				}),
			},
		},
		agency: {
			isCurrentInputInTransaction: (
				_tx: unknown,
				input: { sources: string[] },
			) => !input.sources.some((ref) => options.forgotten?.includes(ref)),
		},
	} as unknown as DialogueDeps;
	// Only the agency's own research has a row in the agency's table.
	const db = {
		query: () => ({
			get: (root: string) => (root === "own" ? { root_id: "own" } : null),
		}),
	} as unknown as Database;
	return { deps, db };
}

const stateOf = (deps: DialogueDeps, db: Database) =>
	stateLinesInTransaction(deps, db, {
		conversationId: "main",
		nowMs,
		lastAt: null,
		lastAgent: null,
		state: null,
		refs,
	}).join("\n");

test("a TODO's line carries its request, the question asked and its tasks by taskId, so the work tool's schema need not", () => {
	const { deps, db } = detailDeps();
	const lines = stateOf(deps, db).split("\n");
	const first = lines.find((line) => line.startsWith("- t1 "))!;
	const detail = JSON.parse(first.slice(first.indexOf("{"))) as {
		request: string;
		question: string;
		tasks: Array<{
			taskId: string;
			title: string;
			state: string;
			reason: string;
		}>;
	};
	expect(first).toContain("- t1 壁紙の作成 質問待ち {");
	expect(detail.request).toBe(
		"夕暮れの猫の壁紙を作って".repeat(40).slice(0, STATE_LIMITS.preview),
	);
	expect(detail.question).toBe("どの色合いにしますか？ 暖色か寒色で");
	expect(detail.tasks).toHaveLength(1);
	expect(detail.tasks[0]).toMatchObject({
		taskId: "task-a",
		title: "下絵",
		state: "running",
	});
	expect(detail.tasks[0]!.reason).toHaveLength(STATE_LIMITS.preview);
	expect(lines.find((line) => line.startsWith("- t2 "))).toBe(
		'- t2 旅行の下調べ 実行中 {"request":"京都の旅行を調べて"}',
	);
});

test("a request the title already says is not told twice", () => {
	const { deps, db } = detailDeps();
	expect(
		stateOf(deps, db)
			.split("\n")
			.find((line) => line.startsWith("- t4 ")),
	).toBe("- t4 同じ依頼 実行中");
});

test("the agency's own research is told by its title only, outside the user's work controls", () => {
	const { deps, db } = detailDeps();
	const own = stateOf(deps, db)
		.split("\n")
		.find((line) => line.startsWith("- t3 "));
	expect(own).toBe("- t3 調査（自分の） 実行中");
});

test("a forgotten TODO is not told in `## State`, with none of its text", () => {
	const { deps, db } = detailDeps({ forgotten: ['host-work:["w1",1]'] });
	const text = stateOf(deps, db);
	expect(text).not.toContain("t1 ");
	expect(text).not.toContain("夕暮れ");
	expect(text).not.toContain("下絵");
	expect(text).toContain("- t2 ");
});
