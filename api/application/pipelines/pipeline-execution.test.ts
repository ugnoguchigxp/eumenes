import { expect, test } from "bun:test";
import { waitFor } from "../../infrastructure/wait-for";
import { harness } from "../toolchain/toolchain.fixture";
import {
	searchThenDelegate,
	toolResults,
} from "../toolchain/conversation-script.fixture";

// Real seed, dialogue, package, scheduler, queue, child adoption, TODO and notices; model outputs alone are scripted.
test("the conversation sends the whole request to the planner and two ordered commands complete under one pipeline TODO", async () => {
	const first = "一つ目のタイマーを作って";
	const second = "二つ目のタイマーを作って";
	const request = `${first}、終わったら${second}`;
	let translations = 0,
		plans = 0;
	const h = await harness({
		pipelines: true,
		timers: true,
		discoveryTarget: () => "execute_pipeline",
		routeTool: "execute_pipeline",
		compose: (messages) => {
			plans++;
			const packet = JSON.parse(messages.at(-1)!.content);
			expect(packet.request).toBe(request);
			expect(translations).toBe(0);
			expect(
				packet.cards.some((c: any) => c.entry === "pipeline.execute"),
			).toBe(false);
			expect(packet.cards.some((c: any) => c.entry === "pipeline.studio")).toBe(
				false,
			);
			expect(
				packet.cards.find((c: any) => c.entry === "timers.manage"),
			).toBeDefined();
			return {
				status: "ready",
				definition: {
					request: packet.request,
					steps: [
						{
							id: "first",
							bundle: "timers.manage",
							task: "一つ目のタイマー",
							from: ["request"],
							result: "保存済みタイマー",
						},
						{
							id: "second",
							bundle: "timers.manage",
							task: "二つ目のタイマー",
							from: ["first"],
							result: "保存済みタイマー",
						},
					],
					output: { from: ["second"], deliver: "結果を表示" },
				},
			};
		},
		command: () =>
			JSON.stringify({
				action: "invoke",
				tool: "timer.start",
				arguments: {
					durationSeconds: ++translations * 60,
					label: `pipeline timer ${translations}`,
				},
			}),
	});
	try {
		const source = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: request,
		});
		await waitFor(() => h.dialogue.get(source.id)?.status === "completed", {
			timeout: 5000,
		});
		expect(h.dialogue.answerText(source.id)).toBe(
			"「パイプライン」に頼みます。",
		);
		await waitFor(
			() =>
				h.toolchain.agents.executions.list("main")[0]?.status === "completed",
			{ timeout: 5000 },
		);
		expect(plans).toBe(1);
		expect(translations).toBe(2);
		const timers = await (await h.request("/api/timers")).json();
		expect(timers.items.map((t: any) => t.label).sort()).toEqual([
			"pipeline timer 1",
			"pipeline timer 2",
		]);
		expect(h.commandContexts).toHaveLength(2);
		const packets = h.commandContexts.map((c) =>
			JSON.parse(JSON.parse(c).at(-1).content),
		);
		expect(packets.every((p) => p.originalRequest === request)).toBe(true);
		expect(packets.map((p) => p.request)).toEqual([
			"一つ目のタイマー\n期待する結果: 保存済みタイマー",
			"二つ目のタイマー\n期待する結果: 保存済みタイマー",
		]);
		const prior = (
			packets[1]!.references as Array<{ ref: string; text: string }>
		).find((item) => item.ref.startsWith("result:"));
		expect(prior?.text).toContain('"label":"pipeline timer 1"');
		expect(h.toolchain.agents.executions.list("main")).toHaveLength(1);
		await waitFor(() => h.reported().length > 0, { timeout: 5000 });
		expect(h.reported()).toContain("completed");
		expect((await h.request("/api/pipelines/publish", {})).status).toBe(404);
		expect((await h.request("/api/pipelines")).status).toBe(404);
	} finally {
		await h.close();
	}
});

test("a failed first pipeline step does not run the dependent step", async () => {
	const first = "一つ目のタイマーを作って";
	const second = "二つ目のタイマーを作って";
	const request = `${first}、終わったら${second}`;
	let commands = 0;
	const h = await harness({
		pipelines: true,
		timers: true,
		discoveryTarget: () => "execute_pipeline",
		routeTool: "execute_pipeline",
		compose: (messages) => {
			const packet = JSON.parse(messages.at(-1)!.content);
			return {
				status: "ready",
				definition: {
					request: packet.request,
					steps: [
						{
							id: "first",
							bundle: "timers.manage",
							task: "一つ目のタイマー",
							from: ["request"],
							result: "保存済みタイマー",
						},
						{
							id: "second",
							bundle: "timers.manage",
							task: "二つ目のタイマー",
							from: ["first"],
							result: "保存済みタイマー",
						},
					],
					output: { from: ["second"], deliver: "結果を表示" },
				},
			};
		},
		command: () => {
			commands++;
			return JSON.stringify({
				action: "invoke",
				tool: "timer.missing",
				arguments: {},
			});
		},
	});
	try {
		const source = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: request,
		});
		await waitFor(() => h.dialogue.get(source.id)?.status === "completed", {
			timeout: 5000,
		});
		await waitFor(
			() => h.toolchain.agents.executions.list("main")[0]?.status === "partial",
			{ timeout: 5000 },
		);
		const parent = h.toolchain.agents.executions.list("main");
		expect(parent).toHaveLength(1);
		expect(parent[0]).toMatchObject({
			status: "partial",
			result: {
				status: "partial",
				code: "toolchain_command_tool_unknown",
				fulfilled: [],
			},
		});
		expect(commands).toBe(1);
		expect(h.commandContexts).toHaveLength(1);
		const steps = h.store.read((db) =>
			db.query("SELECT input_json FROM agent_execution_steps").all(),
		) as Array<{ input_json: string }>;
		expect(steps.map((row) => JSON.parse(row.input_json).request)).toEqual([
			"一つ目のタイマー\n期待する結果: 保存済みタイマー",
		]);
		const timers = await (await h.request("/api/timers")).json();
		expect(timers.items).toEqual([]);
	} finally {
		await h.close();
	}
});

for (const operation of ["answer", "cancel"] as const) {
	test(`conversation ${operation} reaches the waiting pipeline owner without creating replacement work`, async () => {
		const request = "必要な時間を聞いてからタイマーを作って";
		const reply = operation === "answer" ? "15秒です" : "その作業を取り消して";
		let plans = 0,
			commands = 0,
			workCalls = 0;
		const h = await harness({
			pipelines: true,
			timers: true,
			discoveryTarget: () => "execute_pipeline",
			firstRound: (tools, question, messages) => {
				if (question !== reply)
					return searchThenDelegate(
						(c) => c.id === "pipeline.execute",
						request,
						{
							announcement: "順に進めます。",
							impact: "create",
						},
					)(messages);
				if (toolResults(messages, "work").length)
					return {
						text:
							operation === "answer"
								? "回答を伝えました。"
								: "取り消しました。",
					};
				expect(tools.map(({ function: fn }) => fn.name)).toContain("work");
				workCalls++;
				return { calls: [{ name: "work", args: { todo: "t1", operation } }] };
			},
			compose: (messages) => {
				const packet = JSON.parse(messages.at(-1)!.content);
				if (++plans === 1)
					return { status: "needs_input", questions: ["何秒にしますか？"] };
				expect(packet.request).toBe(request);
				expect(JSON.stringify(packet.answers)).toContain(reply);
				return {
					status: "ready",
					definition: {
						request: packet.request,
						steps: [
							{
								id: "timer",
								bundle: "timers.manage",
								task: "15秒のタイマーを作る",
								from: ["request"],
								result: "開始したタイマー",
							},
						],
						output: { from: ["timer"], deliver: "結果" },
					},
				};
			},
			command: () => {
				commands++;
				return JSON.stringify({
					action: "invoke",
					tool: "timer.start",
					arguments: { durationSeconds: 15, label: "answered pipeline" },
				});
			},
		});
		try {
			const page = (state: "active" | "archived") =>
				h.store.read((db) =>
					h.dialogue.todoPageInTransaction(db, "main", {
						state,
						pageIndex: 0,
						pageSize: 10,
					}),
				).rows;
			const source = await h.dialogue.submit({
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
			const before = page("active").find((row) => row.runId === source.id)!;
			expect(before).toMatchObject({
				execution: "pipeline",
				status: "waiting",
			});
			const answered = await h.dialogue.submit({
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: reply,
			});
			await h.dialogue.waitForTerminal(answered.id);
			expect(
				page("active").find((row) => row.id === before.id)?.status,
			).not.toBe("waiting");
			await waitFor(
				() =>
					h.toolchain.agents.executions.get(before.sourceRef!)?.status ===
					(operation === "answer" ? "completed" : "cancelled"),
				{ timeout: 5000 },
			);
			expect(h.toolchain.agents.executions.list("main")).toHaveLength(1);
			expect(
				[...page("active"), ...page("archived")].map((row) => row.id),
			).toEqual([before.id]);
			expect(workCalls).toBe(1);
			expect(commands).toBe(operation === "answer" ? 1 : 0);
			expect(plans).toBe(operation === "answer" ? 2 : 1);
		} finally {
			await h.close();
		}
	});
}
