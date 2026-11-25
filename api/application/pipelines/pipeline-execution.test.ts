import { expect, test } from "bun:test";
import { assignmentFixture } from "../toolchain/assignment.fixture";
import { replyWith } from "../agency/always-on.fixture";

// Real seed, agent, package, scheduler, queue, child adoption and report notes; model outputs alone are scripted.
test("the agent's assignment sends the whole request to the planner and two ordered commands complete under one pipeline execution", async () => {
	const first = "一つ目のタイマーを作って";
	const second = "二つ目のタイマーを作って";
	const request = `${first}、終わったら${second}`;
	let translations = 0,
		plans = 0;
	const f = await assignmentFixture({
		pipelines: true,
		timers: true,
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
	const { h } = f;
	try {
		const { result } = await f.assign(request, "pipeline.execute");
		expect(result).toMatchObject({ status: "accepted" });
		await f.until(() => f.executions()[0]?.status === "completed");
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
		expect(f.executions()).toHaveLength(1);
		// The agent reports the finished pipeline: its work report is a note, and the assignment is no longer open.
		await f.until(() => f.notes().length === 1);
		expect(f.reported()).toContain("completed");
		expect(f.items()).toHaveLength(0);
		expect((await h.request("/api/pipelines/publish", {})).status).toBe(404);
		expect((await h.request("/api/pipelines")).status).toBe(404);
	} finally {
		await f.close();
	}
});

test("a failed first pipeline step does not run the dependent step", async () => {
	const first = "一つ目のタイマーを作って";
	const second = "二つ目のタイマーを作って";
	const request = `${first}、終わったら${second}`;
	let commands = 0;
	const f = await assignmentFixture({
		pipelines: true,
		timers: true,
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
	const { h } = f;
	try {
		await f.assign(request, "pipeline.execute");
		await f.until(() => f.executions()[0]?.status === "partial");
		const parent = f.executions();
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
		await f.close();
	}
});

for (const operation of ["answer", "cancel"] as const) {
	test(`the user's ${operation} reaches the waiting pipeline owner through the assignment, without creating replacement work`, async () => {
		const request = "必要な時間を聞いてからタイマーを作って";
		const reply = operation === "answer" ? "15秒です" : "その作業を取り消して";
		let plans = 0,
			commands = 0;
		const f = await assignmentFixture({
			pipelines: true,
			timers: true,
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
			await f.assign(request, "pipeline.execute");
			await f.until(() => f.executions()[0]?.status === "waiting_user");
			// The pipeline's question is the assignment's: the agent shows it as waiting for the user.
			await f.until(() => !!f.items()[0]?.question);
			const asked = f.items()[0]!;
			expect(asked.question).toBe("何秒にしますか？");
			const words = await f.userWords(reply);
			const { seen } = await replyWith(
				f.f,
				[
					{
						name: "assignment",
						arguments:
							operation === "answer"
								? { id: asked.id, action: "answer", text: reply }
								: { id: asked.id, action: "cancel" },
					},
				],
				{ runId: `run-${operation}`, messageIds: [words.messageId] },
			);
			expect(seen[1]!.filter((m) => m.role === "tool")).toHaveLength(1);
			await f.until(
				() =>
					f.executions()[0]?.status ===
					(operation === "answer" ? "completed" : "cancelled"),
			);
			// Neither reply made a second execution, and the assignment is closed with its work report note.
			expect(f.executions()).toHaveLength(1);
			await f.until(() => f.items().length === 0);
			expect(commands).toBe(operation === "answer" ? 1 : 0);
			expect(plans).toBe(operation === "answer" ? 2 : 1);
		} finally {
			await f.close();
		}
	});
}
