import { expect, test } from "bun:test";
import { waitFor } from "../../infrastructure/wait-for";
import { harness } from "../toolchain/toolchain.fixture";
import type { RouteInput } from "../../domains/larm";
import { weigh } from "../../domains/dialogue/test/router.fixture";
import { searchThenDelegate } from "../toolchain/conversation-script.fixture";

// Real seed, dialogue, package, scheduler, queue, child adoption, TODO and notices; model outputs alone are scripted.
test("B sends ordered steps to the imported planner and two actual commands complete under one pipeline TODO", async () => {
	const first = "一つ目のタイマーを作って";
	const second = "二つ目のタイマーを作って";
	const request = `${first}、終わったら${second}`;
	let translations = 0,
		plans = 0,
		structures = 0;
	const h = await harness({
		pipelines: true,
		timers: true,
		discoveryTarget: () => "execute_pipeline",
		structure: (messages) => {
			structures++;
			expect(JSON.parse(messages.at(-1)!.content).text).toBe(request);
			return {
				requests: [
					{ text: first, target: "一つ目のタイマー", inputs: [], after: [] },
					{ text: second, target: "二つ目のタイマー", inputs: [], after: [0] },
				],
			};
		},
		compose: (messages) => {
			plans++;
			const packet = JSON.parse(messages.at(-1)!.content);
			expect(packet.request).toBe(request);
			expect(packet.routedSteps).toEqual([
				{ text: first, entry: "timers.manage", after: [] },
				{ text: second, entry: "timers.manage", after: [0] },
			]);
			expect(translations).toBe(0);
			if (plans === 2)
				expect(packet.contractErrors).toContain("routed_steps_mismatch");
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
							from: plans === 1 ? ["request"] : ["first"],
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
		Object.assign(h.inference, {
			route: (input: RouteInput, signal: AbortSignal) =>
				weigh({ "timers.manage": input.text === request ? 0.45 : 0.95 })(
					input,
					signal,
				),
		});
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
		expect(structures).toBe(1);
		expect(plans).toBe(2);
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
		await waitFor(() => h.reported().length > 0, { timeout: 5000 });
		expect(h.reported()).toContain("completed");
		expect((await h.request("/api/pipelines/publish", {})).status).toBe(404);
		expect((await h.request("/api/pipelines")).status).toBe(404);
	} finally {
		await h.close();
	}
});

for (const operation of ["answer", "cancel"] as const) {
	test(`B ${operation} reaches the waiting pipeline owner without creating replacement work`, async () => {
		const request = "必要な時間を聞いてからタイマーを作って";
		const reply = operation === "answer" ? "15秒です" : "その作業を取り消して";
		let plans = 0,
			commands = 0,
			structures = 0;
		const h = await harness({
			pipelines: true,
			timers: true,
			discoveryTarget: () => "execute_pipeline",
			structure: (messages) => {
				structures++;
				const packet = JSON.parse(messages.at(-1)!.content);
				expect(packet.text).toBe(reply);
				expect(packet.pending).toEqual([
					{ ref: "t1.answer", title: request, question: "何秒にしますか？" },
				]);
				expect(packet.controls).toEqual([{ ref: "t1.cancel", title: request }]);
				return operation === "answer"
					? { answer: { ref: "t1.answer", text: reply } }
					: { control: { ref: "t1.cancel", text: reply } };
			},
			firstRound: (_tools, question, messages) =>
				question === reply
					? {
							calls: [
								{ name: "work", args: { todo: "t1", operation, text: reply } },
							],
						}
					: searchThenDelegate((c) => c.id === "pipeline.execute", request, {
							announcement: "順に進めます。",
							impact: "create",
						})(messages),
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
			Object.assign(h.inference, { route: weigh({ "timers.manage": 0.45 }) });
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
			expect(structures).toBe(1);
			expect(commands).toBe(operation === "answer" ? 1 : 0);
			expect(plans).toBe(operation === "answer" ? 2 : 1);
		} finally {
			await h.close();
		}
	});
}
