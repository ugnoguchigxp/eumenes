import { taskPlan, taskItem } from "./task-plan.fixture";
import { expect, test } from "bun:test";
import { waitFor } from "../../infrastructure/wait-for";
import { harness } from "./toolchain.fixture";
import {
	afterUtterance,
	candidatesOf,
	findToolchain,
	toolResults,
	UNAVAILABLE_TEXT,
	type Candidate,
} from "./conversation-script.fixture";
import { handOverTask } from "./task-delegation.fixture";

test("the conversation hands a request to the task toolchain and it executes two registered timer commands without merging their source run", async () => {
	let steps = 0,
		translations = 0;
	const observed: string[][] = [];
	const request = "短いタイマーを二つ作って";
	const h = await harness({
		everyday: true,
		timers: true,
		discoveryTarget: (query) =>
			query === "タイマーの作成" ? "timer" : "execute_task",
		firstRound: (_tools, _question, messages) =>
			handOverTask(request, "順に進めます。")(messages),
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
	try {
		await h.timers!.start({
			requestId: crypto.randomUUID(),
			issuedAt: new Date().toISOString(),
			durationSeconds: 60,
			label: "timer 1",
		});
		const source = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: request,
		});
		await waitFor(
			() =>
				["completed", "failed", "interrupted"].includes(
					h.dialogue.get(source.id)!.status,
				),
			{ timeout: 5000 },
		);
		expect(h.dialogue.get(source.id)).toMatchObject({
			status: "completed",
			error: null,
		});
		// The run that handed the work over completes with the announcement as its answer (handed: false).
		expect(h.dialogue.answerText(source.id)).toBe("順に進めます。");
		const list = () =>
			h.store.read((db) =>
				h.toolchain.agents.executions.listInTransaction(db, "main"),
			);
		await waitFor(
			() =>
				["completed", "partial", "failed", "interrupted"].includes(
					list()[0]?.status ?? "",
				),
			{ timeout: 5000 },
		);
		expect(list()[0]).toMatchObject({ status: "completed" });
		expect(translations).toBe(2);
		expect(steps).toBe(4);
		expect(observed[1]).not.toContain("find_toolchain");
		expect(observed[2]).toContain("timer");
		const timers = await h.request("/api/timers");
		expect(timers.status).toBe(200);
		expect((await timers.json()).items).toHaveLength(3);
		const roots = h.toolchain.agents
			.list(source.id)
			.filter((t) => t.kind === "coordinator");
		expect(roots).toHaveLength(2);
		expect(new Set(roots.map((t) => t.id)).size).toBe(2);
		expect(roots.every((t) => t.rootRunId === source.id)).toBe(true);
		// Only the two children translate commands; the parent hands the request over without a command.
		expect(h.commandContexts).toHaveLength(2);
		for (const context of h.commandContexts) {
			const messages = JSON.parse(context);
			const packet = JSON.parse(messages.at(-1).content);
			expect(packet.executionStep).toBe(true);
			expect(packet.execution.sourceRunId).toBe(source.id);
			expect(
				packet.snapshot.items.some(
					(item: { label: string; originRunId: string | null }) =>
						item.label === "timer 1" && item.originRunId === null,
				),
			).toBe(true);
			expect(packet.originalRequest).toBe(request);
		}
	} finally {
		await h.close();
	}
}, 15_000);

test("a question of a task is reported into its TODO, ordinary chat keeps it waiting, and the work answer resumes it once", async () => {
	let steps = 0;
	let h!: Awaited<ReturnType<typeof harness>>;
	const request = "候補を選んで内容を説明して";
	/** The TODO that waits for the question (the one open TODO of the conversation). */
	const todoOfExecution = () => ({
		todo: h.store
			.read((db) => h.dialogue.todosInTransaction(db, "main"))
			.find((item) => item.status === "waiting")!,
	});
	h = await harness({
		everyday: true,
		discoveryTarget: () => "execute_task",
		firstRound: (_tools, question, messages) => {
			if (question === "雑談です") return { text: "雑談ですね。" };
			if (question === "二番目で続けて") {
				if (toolResults(afterUtterance(messages), "work").length === 0) {
					const { todo } = todoOfExecution();
					return {
						calls: [
							{
								name: "work",
								args: {
									todo: `t${todo.ref}`,
									operation: "answer",
									text: "二番目",
								},
							},
						],
					};
				}
				return { text: "二番目で続けます。" };
			}
			return handOverTask(request, "候補を選んで説明します。")(messages);
		},
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
	const events = () =>
		h.store.read((db) =>
			db.query("SELECT state FROM agent_execution_events ORDER BY rowid").all(),
		) as { state: string }[];
	try {
		await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: request,
		});
		await waitFor(
			() =>
				h.toolchain.agents.executions.list("main")[0]?.status ===
				"waiting_user",
			{ timeout: 5000 },
		);
		const work = h.toolchain.agents.executions.list("main")[0]!;
		await waitFor(() => events()[0]?.state === "delivered", { timeout: 5000 });
		const chat = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "雑談です",
		});
		await h.dialogue.waitForTerminal(chat.id, { timeoutMs: 5000 });
		expect(h.toolchain.agents.executions.get(work.id)?.status).toBe(
			"waiting_user",
		);
		const answer = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "二番目で続けて",
		});
		await h.dialogue.waitForTerminal(answer.id, { timeoutMs: 5000 });
		expect(h.dialogue.answerText(answer.id)).toBe("二番目で続けます。");
		await waitFor(
			() =>
				h.toolchain.agents.executions.get(work.id)?.status === "completed" &&
				events().at(-1)?.state === "delivered",
			{ timeout: 5000 },
		);
		expect(steps).toBe(2);
		expect(events()).toEqual([{ state: "delivered" }, { state: "delivered" }]);
		expect(h.toolchain.agents.executions.list("other-conversation")).toEqual(
			[],
		);
		await h.store.write((db) =>
			h.toolchain.agents.executions.purgeSourcesInTransaction(db, {
				messageIds: [answer.inputMessageId],
				itemIds: [],
			}),
		);
		expect(h.toolchain.agents.executions.list("main")).toEqual([]);
	} finally {
		await h.close();
	}
}, 15000);

test("an instant child keeps the registered arguments and follows its explicit research fallback inside the same logical call", async () => {
	const { weatherFetch } = await import("../weather/weather.fixture");
	const weather = weatherFetch({
		forecast: () => new Response("unavailable", { status: 503 }),
	});
	let steps = 0;
	const request = "明日の鎌倉の天気を確認して結果を整理する";
	const h = await harness({
		everyday: true,
		weather: { fetch: weather.fetch },
		discoveryTarget: (query) =>
			query === "weather forecast" ? "weather_forecast" : "execute_task",
		firstRound: (_tools, _question, messages) =>
			handOverTask(request, "明日の天気を確認します。")(messages),
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
			expect(packet.results[0].state).toBe("completed");
			return {
				name: "complete_task",
				arguments: {
					summary: "代替の調査結果を確認しました。",
					fulfilled: ["forecast checked"],
					missing: [],
					refs: packet.results.flatMap((r: { refs: string[] }) => r.refs),
				},
			};
		},
	});
	try {
		await h.toolchain.weather!.maintain();
		const source = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: request,
		});
		await waitFor(
			() =>
				h.toolchain.agents.executions.list("main")[0]?.status === "completed",
			{ timeout: 5000 },
		);
		expect(steps).toBe(3);
		expect(h.dialogue.answerText(source.id)).toBe("明日の天気を確認します。");
		const rows = h.store.read((db) =>
			db
				.query("SELECT input_json,result_json FROM agent_execution_steps")
				.all(),
		) as { input_json: string; result_json: string }[];
		expect(rows).toHaveLength(1);
		expect(JSON.parse(rows[0]!.input_json)).toMatchObject({
			source: { runId: source.id },
			arguments: { place: "鎌倉", day: "tomorrow" },
		});
		expect(JSON.parse(rows[0]!.result_json).ref.kind).toBe("research");
		expect(h.commandContexts).toEqual([]);
	} finally {
		await h.close();
	}
}, 10000);

test("a session capability returns a checked handoff and does not secretly create or operate a session", async () => {
	let steps = 0;
	const request = "検索した資料を元に対話形式で画面を制作する";
	const h = await harness({
		everyday: true,
		uiCompositions: true,
		discoveryTarget: (query) =>
			query === "interactive screen design" ? "ui_create" : "execute_task",
		firstRound: (_tools, _question, messages) =>
			handOverTask(request, "画面の制作を始めます。")(messages),
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
	try {
		await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: request,
		});
		await waitFor(
			() => h.toolchain.agents.executions.list("main")[0]?.status === "partial",
			{ timeout: 5000 },
		);
		expect(h.toolchain.agents.executions.list("main")[0]).toMatchObject({
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
		await h.close();
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
