import { taskPlan, taskItem } from "./task-plan.fixture";
import { expect, test } from "bun:test";
import { harness } from "./toolchain.fixture";
import {
	candidatesOf,
	findToolchain,
	UNAVAILABLE_TEXT,
	type Candidate,
} from "./conversation-script.fixture";
import { TASK_TOOLCHAIN } from "./task-delegation.fixture";
import { assignmentFixture } from "./assignment.fixture";
import { replyWith } from "../agency/always-on.fixture";

test("an assignment of the task toolchain executes two registered timer commands without merging their source run", async () => {
	let steps = 0,
		translations = 0;
	const observed: string[][] = [];
	const request = "短いタイマーを二つ作って";
	const f = await assignmentFixture({
		everyday: true,
		timers: true,
		discoveryTarget: (query) =>
			query === "タイマーの作成" ? "timer" : "execute_task",
		command: () =>
			JSON.stringify({
				action: "invoke",
				tool: "timer.start",
				arguments: {
					durationSeconds: ++translations * 60,
					label: `timer ${translations}`,
				},
			}),
		taskStep: (tools, messages) => {
			const current = JSON.parse(messages.at(-1)!.content);
			if (current.plan.required)
				return taskPlan("1個目のタイマーを作る", "2個目のタイマーを作る");
			observed.push(tools.map((t) => t.function.name));
			steps++;
			if (steps === 1) {
				const packet = JSON.parse(messages.at(-1)!.content);
				expect(messages[1]).toEqual({
					role: "user",
					content:
						"CONVERSATION_REFERENCE=" +
						JSON.stringify({ delegationSummary: request }),
				});
				expect(packet).not.toHaveProperty("delegationSummary");
				expect(packet.originalRequest).toBe(request);
				expect(packet).not.toHaveProperty("request");
				return {
					name: "find_toolchain",
					arguments: { query: "タイマーの作成" },
				};
			}
			if (steps <= 3)
				return {
					name: "timer",
					arguments: {
						stepRef: taskItem(current, steps - 2),
						contextRefs: [],
					},
				};
			const packet = JSON.parse(messages.at(-1)!.content);
			expect(packet.results).toHaveLength(2);
			expect(packet.results[0].output).toMatchObject({
				kind: "timer_action",
				action: "started",
				items: [{ label: "timer 1", durationSeconds: 60 }],
			});
			expect(packet.results[0]).not.toHaveProperty("summary");
			expect(packet.childCallsLeft).toBe(4);
			expect(
				packet.results.map(
					(result: { stepRequest: string }) => result.stepRequest,
				),
			).toEqual(["1個目のタイマーを作る", "2個目のタイマーを作る"]);
			expect(
				packet.results.every((result: { toolchainRevisionId: string }) =>
					result.toolchainRevisionId.startsWith("toolchain:"),
				),
			).toBe(true);
			return {
				name: "complete_task",
				arguments: {
					summary: "タイマーを二つ作成しました。",
					fulfilled: ["2 timers saved"],
					missing: [],
					refs: packet.results.flatMap((r: { refs: string[] }) => r.refs),
				},
			};
		},
	});
	const { h } = f;
	try {
		await h.timers!.start({
			requestId: crypto.randomUUID(),
			issuedAt: new Date().toISOString(),
			durationSeconds: 60,
			label: "timer 1",
		});
		const { source, result } = await f.assign(request, TASK_TOOLCHAIN);
		expect(result).toMatchObject({ status: "accepted" });
		await f.until(
			() =>
				["completed", "partial", "failed", "interrupted"].includes(
					f.executions()[0]?.status ?? "",
				),
			15_000,
		);
		expect(f.executions()[0]).toMatchObject({ status: "completed" });
		expect(translations).toBe(2);
		expect(steps).toBe(4);
		expect(observed[1]).not.toContain("find_toolchain");
		expect(observed[2]).toContain("timer");
		const timers = await h.request("/api/timers");
		expect(timers.status).toBe(200);
		expect((await timers.json()).items).toHaveLength(3);
		const roots = h.toolchain.agents
			.list(source.runId)
			.filter((t) => t.kind === "coordinator");
		expect(roots).toHaveLength(2);
		expect(new Set(roots.map((t) => t.id)).size).toBe(2);
		expect(roots.every((t) => t.rootRunId === source.runId)).toBe(true);
		// The agent reports the finished task as a note; the assignment is no longer open.
		await f.until(() => f.notes().length === 1);
		expect(f.items()).toHaveLength(0);
		// Only the two children translate commands; the parent hands the request over without a command.
		expect(h.commandContexts).toHaveLength(2);
		for (const context of h.commandContexts) {
			const messages = JSON.parse(context);
			const packet = JSON.parse(messages.at(-1).content);
			expect(packet.executionStep).toBe(true);
			expect(packet.execution.sourceRunId).toBe(source.runId);
			expect(
				packet.snapshot.items.some(
					(item: { label: string; originRunId: string | null }) =>
						item.label === "timer 1" && item.originRunId === null,
				),
			).toBe(true);
			expect(packet.originalRequest).toBe(request);
		}
	} finally {
		await f.close();
	}
}, 15_000);

test("a question of a task is the assignment's question, ordinary chat keeps it waiting, and the answer through the assignment resumes it once", async () => {
	let steps = 0;
	const request = "候補を選んで内容を説明して";
	const f = await assignmentFixture({
		everyday: true,
		discoveryTarget: () => "execute_task",
		taskStep: (_tools, messages) => {
			const current = JSON.parse(messages.at(-1)!.content);
			if (current.plan.required) return taskPlan("候補を選んで内容を説明する");
			steps++;
			if (steps === 1)
				return {
					name: "ask_user",
					arguments: { question: "一番目と二番目のどちらを選びますか。" },
				};
			const packet = JSON.parse(messages.at(-1)!.content);
			expect(packet.userAnswers[0].request).toContain("二番目");
			return {
				name: "complete_task",
				arguments: {
					summary: "二番目の候補を選択しました。",
					fulfilled: ["user choice recorded"],
					missing: [],
					refs: [],
				},
			};
		},
	});
	const { h } = f;
	const events = () =>
		h.store.read((db) =>
			db.query("SELECT state FROM agent_execution_events ORDER BY rowid").all(),
		) as { state: string }[];
	try {
		await f.assign(request, TASK_TOOLCHAIN);
		await f.until(() => f.executions()[0]?.status === "waiting_user");
		const work = f.executions()[0]!;
		// The task's question is the assignment's: the agent shows the item as waiting for the user.
		await f.until(() => !!f.items()[0]?.question);
		const asked = f.items()[0]!;
		expect(asked.question).toBe("一番目と二番目のどちらを選びますか。");
		// Ordinary chat keeps the work waiting.
		const chat = await f.userWords("雑談です");
		await replyWith(f.f, [], {
			runId: "run-chat",
			messageIds: [chat.messageId],
		});
		expect(f.executions()[0]).toMatchObject({
			id: work.id,
			status: "waiting_user",
		});
		// The user's choice is handed to the waiting task through the assignment.
		const answer = await f.userWords("二番目で続けて");
		await replyWith(
			f.f,
			[
				{
					name: "assignment",
					arguments: { id: asked.id, action: "answer", text: "二番目" },
				},
			],
			{ runId: "run-answer", messageIds: [answer.messageId] },
		);
		await f.until(() => f.executions()[0]?.status === "completed");
		expect(steps).toBe(2);
		expect(events().length).toBeGreaterThan(0);
		expect(events().every((event) => event.state === "delivered")).toBe(true);
		expect(h.toolchain.agents.executions.list("other-conversation")).toEqual(
			[],
		);
		await f.until(() => f.notes().length === 1);
		await h.store.write((db) =>
			h.toolchain.agents.executions.purgeSourcesInTransaction(db, {
				messageIds: [answer.messageId],
				itemIds: [],
			}),
		);
		expect(f.executions()).toEqual([]);
	} finally {
		await f.close();
	}
}, 30000);

test("an instant child keeps the registered arguments and reports the provider failure without invoking another capability", async () => {
	const { weatherFetch } = await import("../weather/weather.fixture");
	const weather = weatherFetch({
		forecast: () => new Response("unavailable", { status: 503 }),
	});
	let steps = 0;
	const request = "明日の鎌倉の天気を確認して結果を整理する";
	const f = await assignmentFixture({
		everyday: true,
		weather: { fetch: weather.fetch },
		discoveryTarget: (query) =>
			query === "weather forecast" ? "weather_forecast" : "execute_task",
		taskStep: (_tools, messages) => {
			const current = JSON.parse(messages.at(-1)!.content);
			if (current.plan.required) return taskPlan("明日の鎌倉の天気を確認する");
			steps++;
			const packet = JSON.parse(messages.at(-1)!.content);
			if (steps === 1)
				return {
					name: "find_toolchain",
					arguments: { query: "weather forecast" },
				};
			if (steps === 2)
				return {
					name: "weather_forecast",
					arguments: {
						stepRef: taskItem(current),
						arguments: {
							place: "鎌倉",
							prefecture: "神奈川県",
							day: "tomorrow",
						},
						contextRefs: [],
					},
				};
			expect(packet.results[0].state).toBe("failed");
			return {
				name: "complete_task",
				arguments: {
					summary: "天気を取得できませんでした。",
					fulfilled: [],
					missing: ["forecast unavailable"],
					refs: packet.results.flatMap((r: { refs: string[] }) => r.refs),
				},
			};
		},
	});
	const { h } = f;
	try {
		await h.toolchain.weather!.maintain();
		const { source } = await f.assign(request, TASK_TOOLCHAIN);
		await f.until(() => f.executions()[0]?.status === "partial");
		expect(steps).toBe(4);
		// The agent reports the partial result as a note; the assignment is no longer open.
		await f.until(() => f.notes().length === 1);
		const rows = h.store.read((db) =>
			db
				.query("SELECT input_json,result_json FROM agent_execution_steps")
				.all(),
		) as { input_json: string; result_json: string }[];
		expect(rows).toHaveLength(1);
		expect(JSON.parse(rows[0]!.input_json)).toMatchObject({
			source: { runId: source.runId },
			arguments: { place: "鎌倉", day: "tomorrow" },
		});
		expect(JSON.parse(rows[0]!.result_json)).toMatchObject({ state: "failed" });
		expect(h.workerContexts).toEqual([]);
		expect(h.commandContexts).toEqual([]);
	} finally {
		await f.close();
	}
}, 10000);

test("a session capability returns a checked handoff and does not secretly create or operate a session", async () => {
	let steps = 0;
	const request = "検索した資料を元に対話形式で画面を制作する";
	const f = await assignmentFixture({
		everyday: true,
		uiCompositions: true,
		discoveryTarget: (query) =>
			query === "interactive screen design" ? "ui_create" : "execute_task",
		taskStep: (_tools, messages) => {
			const packet = JSON.parse(messages.at(-1)!.content);
			if (packet.plan.required)
				return taskPlan("Start an interactive screen design from the findings");
			return ++steps === 1
				? {
						name: "find_toolchain",
						arguments: { query: "interactive screen design" },
					}
				: {
						name: "ui_create",
						arguments: {
							stepRef: taskItem(packet),
							contextRefs: [],
						},
					};
		},
	});
	const { h } = f;
	try {
		await f.assign(request, TASK_TOOLCHAIN);
		await f.until(() => f.executions()[0]?.status === "partial");
		expect(f.executions()[0]).toMatchObject({
			result: { code: "interactive_handoff" },
		});
		const rows = h.store.read((db) =>
			db.query("SELECT result_json FROM agent_execution_steps").all(),
		) as { result_json: string }[];
		expect(JSON.parse(rows[0]!.result_json).ref).toMatchObject({
			kind: "session",
			adapterRef: "adapter:ui-compositions@1",
			requiresUnsavedConfirmation: false,
		});
		expect(
			h.store.read((db) =>
				db
					.query("SELECT count(*) AS n FROM dialogue_specialist_sessions")
					.get(),
			),
		).toEqual({ n: 0 });
	} finally {
		await f.close();
	}
}, 10000);

test("registered command candidates disclose their one-operation execution contract at selection time", async () => {
	let found: Candidate[] | undefined;
	const h = await harness({
		timers: true,
		everyday: true,
		discoveryTarget: () => "timer",
		firstRound: (_tools, _question, messages) => {
			found = candidatesOf(messages);
			if (!found) return { calls: [findToolchain("タイマーを作る")] };
			return { text: UNAVAILABLE_TEXT };
		},
	});
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "タイマーを作る",
		});
		await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 });
		const timer = found?.find((candidate) => candidate.id === "timers.manage");
		expect(timer).toBeDefined();
		expect(timer!.execution).toBe("command");
	} finally {
		await h.close();
	}
});
