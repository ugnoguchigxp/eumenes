import { taskPlan, taskItem } from "./task-plan.fixture";
import { expect, test } from "bun:test";
import { analysisArgs } from "../../domains/dialogue/test/analysis.fixture";
import { waitFor } from "../../infrastructure/wait-for";
import { harness } from "./toolchain.fixture";

const requestArgs = (request: string) => ({
	...analysisArgs({ kind: "action", impact: "create" }),
	request,
	contextRefs: [],
	announcement: "順に進めます。",
});
test("the public conversation entry starts a parent directly and executes two registered timer commands without merging their source run", async () => {
	let steps = 0,
		translations = 0;
	const observed: string[][] = [];
	const h = await harness({
		everyday: true,
		timers: true,
		routeTool: "timer",
		firstRound: () => ({
			name: "execute_task",
			args: requestArgs("一つ目の短いタイマーを作る"),
		}),
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
						JSON.stringify({ delegationSummary: "一つ目の短いタイマーを作る" }),
				});
				expect(packet).not.toHaveProperty("delegationSummary");
				expect(packet.originalRequest).toBe("短いタイマーを二つ作って");
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
			text: "短いタイマーを二つ作って",
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
		expect(h.commandContexts).toHaveLength(2); // Only the two children translate commands; the parent uses the R1 request directly.
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
			expect(packet.originalRequest).toBe("短いタイマーを二つ作って");
		}
	} finally {
		await h.close();
	}
}, 15_000);

test("a public question is adopted in the original conversation, ordinary chat keeps the parent alive, and the answer resumes it once", async () => {
	let steps = 0;
	let work: import("../../domains/tool-runtime").ExecutionView;
	const h = await harness({
		everyday: true,
		firstRound: (_tools, question) =>
			question === "雑談です"
				? { name: "answer", args: analysisArgs({ kind: "chat" }) }
				: question === "二番目で続けて"
					? {
							name: "task_control",
							args: {
								...analysisArgs({ kind: "action", impact: "none" }),
								workRef: work.id,
								expectedRevision: work.revision,
								action: "answer",
								questionRef: work.question!.id,
								input: "二番目",
								announcement: "二番目で続けます。",
							},
						}
					: {
							name: "execute_task",
							args: requestArgs("候補を選んで内容を説明して"),
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
			expect(packet.userAnswers[0].request).toBe("二番目で続けて");
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
			text: "候補を選んで内容を説明して",
		});
		await waitFor(
			() =>
				h.toolchain.agents.executions.list("main")[0]?.status ===
				"waiting_user",
			{ timeout: 5000 },
		);
		work = h.toolchain.agents.executions.list("main")[0]!;
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
	const h = await harness({
		everyday: true,
		weather: { fetch: weather.fetch },
		routeTool: "weather_forecast",
		firstRound: () => ({
			name: "execute_task",
			args: requestArgs("明日の鎌倉の天気を確認して結果を整理する"),
		}),
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
			text: "明日の鎌倉の天気を確認して結果を整理して",
		});
		await waitFor(
			() =>
				h.toolchain.agents.executions.list("main")[0]?.status === "completed",
			{ timeout: 5000 },
		);
		expect(steps).toBe(3);
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
	const h = await harness({
		everyday: true,
		uiCompositions: true,
		routeTool: "ui_create",
		firstRound: () => ({
			name: "execute_task",
			args: requestArgs("検索した資料を元に対話形式で画面を制作する"),
		}),
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
			text: "資料から対話して画面を作って",
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
	const { createToolchainRouting } = await import("./toolchain-routing");
	const { analysisTools } =
		await import("../../domains/dialogue/service/initial-decision");
	const h = await harness({ timers: true, everyday: true });
	try {
		const routing = createToolchainRouting(
			h.toolchain.capabilities,
			h.toolchain.history,
			async () => undefined,
			h.toolchain.registry,
			h.toolchain.schemas,
		);
		const card = h.store.read((db) =>
			routing.cardInTransaction(
				db,
				h.toolchain.capabilities
					.toolchainsInTransaction(db)
					.find((d) => d.id === "timers.manage")!.revisionId,
			),
		)!;
		expect(card.execution).toBe("command");
		expect(analysisTools([card])[0]!.function.description).toContain(
			"実行形式: command",
		);
	} finally {
		await h.close();
	}
});
