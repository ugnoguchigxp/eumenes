import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import type { Runner, Work } from "../contracts";
import { migrations, save } from "../repository";
import { createWatch, narrationLines, toolLines } from "../watch";

// eslint-disable-next-line no-control-regex -- The colours of the pane are what the test strips.
const colours = /\x1b\[[0-9;]*m/g;
const plain = (lines: string[]) =>
	lines.map((line) => line.replace(colours, ""));

function openTestStore() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-claude-watch-"));
	const store = openStore(join(dir, "db"), [
		{ id: "queue/0001-init", sql: "CREATE TABLE queue_stub (id TEXT)" },
		...migrations,
	]);
	return {
		store,
		async close() {
			await store.close().catch(() => {});
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

const standard = {
	conversationId: "main",
	messageId: "m1",
	runId: "r1",
	request: "やって",
	digest: "d",
};

function work(over: Partial<Work> & { id: string }): Work {
	return {
		source: standard,
		binding: "binding:claude-code.managed@1",
		request: "設定から背景色を変えられるようにしてください。",
		references: [],
		profile: "",
		skills: [],
		deadline: Date.now() + 60_000,
		generation: 0,
		revision: 0,
		status: "waiting_child",
		summary: "依頼を受け付けました。",
		observedAt: Date.parse("2026-11-25T11:48:49Z"),
		startedAt: Date.parse("2026-11-25T11:48:49Z"),
		memo: "",
		question: null,
		questionFromRunner: false,
		result: null,
		observation: null,
		calls: 0,
		executions: 0,
		turnsReserved: 0,
		turnsUsedBeforeExecution: 0,
		maxCalls: 24,
		maxExecutions: 8,
		attemptMs: 120_000,
		decisionId: null,
		decisionMode: "work",
		progressCalls: 0,
		progressSeq: -1,
		progressAt: 0,
		effect: null,
		executionId: null,
		previousId: null,
		answers: [],
		amendments: [],
		notice: null,
		forgotten: false,
		holdsWorkspace: false,
		stop: undefined,
		mode: "work",
		conversationSummary: "next_turn",
		...over,
	} as Work;
}

async function readAll(response: Response) {
	const text = await new Response(response.body).text();
	let output = "";
	let exited = false;
	for (const block of text.split("\n\n")) {
		const event = /^event: (.+)$/m.exec(block)?.[1];
		const data = /^data: (.*)$/m.exec(block)?.[1];
		if (event === "output" && data)
			output += Buffer.from(data, "base64").toString();
		if (event === "exit") exited = true;
	}
	return { output: output.replace(colours, ""), exited };
}

test("a tool event becomes a short line, its output a few dim lines, even when the event was cut", () => {
	const bash = JSON.stringify({
		tool: "Bash",
		input: { command: "bun test api/domains/settings\nsecond line" },
		result: { stdout: "1\n2\n3\n4\n5\n6\n7\n8", stderr: "" },
	});
	expect(plain(toolLines(bash))).toEqual([
		"  $ bun test api/domains/settings",
		"    1",
		"    2",
		"    3",
		"    4",
		"    5",
		"    6",
		"    …（ほか 2 行）",
	]);
	const edit = JSON.stringify({
		tool: "Edit",
		input: { file_path: "/repo/web/src/a.tsx", old_string: "x" },
	});
	expect(plain(toolLines(edit, "/repo"))).toEqual(["  ✎ Edit web/src/a.tsx"]);
	// The runner hands at most 4,000 characters of an event: the JSON may end mid-string.
	const cut = `{"id":"toolu_1","tool":"Bash","input":{"command":"grep -n \\"背景色\\" docs/avatar.md"},"result":{"stdout":"9:同じパネルの「背景」欄では、モデル`;
	expect(plain(toolLines(cut))).toEqual([
		'  $ grep -n "背景色" docs/avatar.md',
		"    9:同じパネルの「背景」欄では、モデル",
	]);
	// Escape sequences in a tool's output never reach the pane.
	const coloured = JSON.stringify({
		tool: "Bash",
		input: { command: "ls" },
		result: { stdout: "\x1b[31mred\x1b[0m\x1b]0;title\x07" },
	});
	expect(toolLines(coloured)[1]).not.toContain("\x1b[31m");
	// C1 controls act like ESC in a terminal: removed too.
	const c1 = JSON.stringify({
		tool: "Bash",
		input: { command: "cat x" },
		result: { stdout: "a\u009b2Jb\u009d0;t" },
	});
	expect(plain(toolLines(c1))[1]).toBe("    a2Jb0;t");
	// A failed tool shows why; a plain-text record (the supervised path) shows its first line.
	const failed = JSON.stringify({
		tool: "Bash",
		input: { command: "bun test" },
		error: "Exit code 1\nmore",
		failed: true,
	});
	expect(plain(toolLines(failed))).toEqual([
		"  $ bun test",
		"    ✗ Exit code 1",
	]);
	expect(plain(toolLines("Read web/src/a.ts\nmore"))).toEqual([
		"  · Read web/src/a.ts",
	]);
	expect(
		plain(narrationLines("設定画面を確認します。\n\n次にテストします。")),
	).toEqual([
		"  Claude: 設定画面を確認します。",
		"          次にテストします。",
	]);
});

test("a finished work is written in full: its executions, Claude's words, the owner's decisions and the result", async () => {
	const { store, close } = openTestStore();
	try {
		const done = work({
			id: crypto.randomUUID(),
			status: "completed",
			executionIds: [
				"11111111-1111-4111-8111-111111111111",
				"22222222-2222-4222-8222-222222222222",
			],
			memo: "検証の残りを同じ仕事で続ける。",
			summary: "完了しました。",
			result: {
				status: "completed",
				summary: "設定画面から背景色を変えられるようにしました。",
				fulfilled: [],
				missing: [],
				refs: [],
			},
		});
		await store.write((db) => save(db, done, Date.now()));
		const events: Record<string, string[]> = {
			"11111111-1111-4111-8111-111111111111": [
				JSON.stringify({ tool: "Read", input: { file_path: "/repo/a.ts" } }),
				JSON.stringify({
					tool: "Bash",
					input: { command: "bun test" },
					result: { stdout: "240 pass" },
				}),
			],
			"22222222-2222-4222-8222-222222222222": [
				JSON.stringify({ tool: "Edit", input: { file_path: "/repo/b.ts" } }),
			],
		};
		const runner = {
			ready: () => true,
			async events(id: string, after: number) {
				const all = events[id] ?? [];
				return {
					events: all
						.slice(after)
						.map((text, i) => ({ seq: after + i + 1, text })),
					next: all.length,
				};
			},
			async narration(id: string, after: number) {
				const items =
					id === "11111111-1111-4111-8111-111111111111"
						? [
								{ n: 1, afterSeq: 0, text: "まず該当箇所を読みます。" },
								{ n: 2, afterSeq: 1, text: "テストを走らせます。" },
							]
						: [];
				return {
					items: items.filter((item) => item.n > after),
					next: items.length,
				};
			},
			async inspect(id: string) {
				return {
					executionId: id,
					seq: 1,
					state: "finished" as const,
					resultSubtype: id.startsWith("1") ? "error_max_turns" : "success",
					turns: id.startsWith("1") ? 8 : 3,
					managedExecutionStopped: true,
				};
			},
		} as unknown as Runner;
		const watch = createWatch({
			store,
			runnerFor: () => runner,
			root: "/repo",
		});
		const response = await watch.stream(done.id, new AbortController().signal);
		const { output, exited } = await readAll(response!);
		expect(exited).toBe(true);
		const order = [
			"━━ Claude Code（専任担当）",
			"依頼: 設定から背景色を変えられるようにしてください。",
			"▶ 実行 1",
			"Claude: まず該当箇所を読みます。",
			"· Read a.ts",
			"Claude: テストを走らせます。",
			"$ bun test",
			"240 pass",
			"■ 実行 1 終了（error_max_turns・8 ターン）",
			"▶ 実行 2",
			"✎ Edit b.ts",
			"■ 実行 2 終了（success・3 ターン）",
			"担当メモ: 検証の残りを同じ仕事で続ける。",
			"━━ 完了: 設定画面から背景色を変えられるようにしました。",
		];
		let at = 0;
		for (const part of order) {
			const found = output.indexOf(part, at);
			expect({ part, found: found >= 0 }).toEqual({ part, found: true });
			at = found + part.length;
		}
		// The owner's final summary is the result line, not an "担当:" line as well.
		expect(output).not.toContain("担当: 完了しました。");
		watch.close();
	} finally {
		await close();
	}
});

test("the list shows the works handed over, not the supervised goal runs, and a few finished ones", async () => {
	const { store, close } = openTestStore();
	try {
		const at = Date.now();
		const asking = work({
			id: crypto.randomUUID(),
			startedAt: at - 120_000,
			status: "waiting_user",
			question: {
				id: crypto.randomUUID(),
				prompt: "どの画面ですか？",
				expiresAt: at + 60_000,
				inputSchema: {},
			},
		});
		const supervised = work({
			id: crypto.randomUUID(),
			source: { origin: "supervised" } as unknown as Work["source"],
		});
		const forgotten = work({ id: crypto.randomUUID(), forgotten: true });
		// Shown in the order they were accepted, whatever was saved last.
		const finished = [1, 2, 3, 4].map((i) =>
			work({
				id: crypto.randomUUID(),
				status: "completed",
				request: `終わった仕事 ${i}`,
				startedAt: at - 60_000 + i,
			}),
		);
		await store.write((db) => {
			finished.forEach((w, i) => save(db, w, at - 10_000 + i));
			save(db, asking, at);
			save(db, supervised, at);
			save(db, forgotten, at);
		});
		const watch = createWatch({ store, runnerFor: () => undefined });
		const panes = store.read((db) => watch.listInTransaction(db));
		expect(panes.map((p) => p.title)).toEqual([
			"設定から背景色を変えられるようにしてください。",
			"終わった仕事 2",
			"終わった仕事 3",
			"終わった仕事 4",
		]);
		expect(panes[0]).toMatchObject({
			status: "running",
			activity: "waiting",
		});
		expect(panes[1]).toMatchObject({
			status: "exited",
			activity: "idle",
			statusMessage: "完了",
		});
		// Every work handed over counts (the screen opens when the count grows); the others do not.
		expect(store.read((db) => watch.requestsInTransaction(db))).toBe(6);
		expect(store.read((db) => watch.hasInTransaction(db, supervised.id))).toBe(
			false,
		);
		expect(
			await watch.stream(forgotten.id, new AbortController().signal),
		).toBeNull();
		watch.close();
	} finally {
		await close();
	}
});

test("a finished work whose runner record cannot be read still ends its pane", async () => {
	const { store, close } = openTestStore();
	try {
		const done = work({
			id: crypto.randomUUID(),
			status: "failed",
			executionIds: ["44444444-4444-4444-8444-444444444444"],
			summary: "作業期限に達しました。",
		});
		await store.write((db) => save(db, done, Date.now()));
		const runner = {
			ready: () => true,
			events: async () => {
				throw new Error("runner_unavailable");
			},
			inspect: async () => null,
		} as unknown as Runner;
		const watch = createWatch({ store, runnerFor: () => runner });
		const response = await watch.stream(done.id, new AbortController().signal);
		const { output, exited } = await readAll(response!);
		expect(exited).toBe(true);
		expect(output).toContain("この実行の記録を読めませんでした");
		expect(output).toContain("━━ 失敗: 作業期限に達しました。");
		watch.close();
	} finally {
		await close();
	}
});
