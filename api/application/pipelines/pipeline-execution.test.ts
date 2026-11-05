import { expect, test } from "bun:test";
import { waitFor } from "../../infrastructure/wait-for";
import { harness } from "../toolchain/toolchain.fixture";
import { searchThenDelegate } from "../toolchain/conversation-script.fixture";

// Real seed, dialogue, package, scheduler, queue, child adoption, TODO and notices; model outputs alone are scripted.
test("conversation selects the imported planner and two actual timer commands complete under one pipeline TODO", async () => {
	const request = "一つ目の結果を確認してから二つ目のタイマーを作って";
	let translations = 0,
		plans = 0;
	const h = await harness({
		pipelines: true,
		timers: true,
		discoveryTarget: () => "execute_pipeline",
		firstRound: (_tools, _question, messages) =>
			searchThenDelegate((c) => c.id === "pipeline.execute", request, {
				announcement: "順に進めます。",
				impact: "create",
			})(messages),
		compose: (messages) => {
			plans++;
			const packet = JSON.parse(messages.at(-1)!.content);
			expect(packet.request).toBe(request);
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
		await waitFor(() => h.reported().length > 0, { timeout: 5000 });
		expect(h.reported()).toContain("completed");
		expect((await h.request("/api/pipelines/publish", {})).status).toBe(404);
		expect((await h.request("/api/pipelines")).status).toBe(404);
	} finally {
		await h.close();
	}
});
