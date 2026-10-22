import { expect, test } from "bun:test";
import type { PipelineDefinition } from "../../domains/capabilities";
import { waitFor } from "../../infrastructure/wait-for";
import { harness } from "../toolchain/toolchain.fixture";
import { analysisTools } from "../../domains/dialogue/service/initial-decision";
import { RESERVED_INPUT_NAMES } from "../../domains/pipelines/service/check";

/** Two timers with a value taken out of the first one's result in between: commands and an extract only. */
const relay: PipelineDefinition = {
	formatVersion: 1,
	id: "timer-relay",
	title: "続けて掛けるタイマー",
	summary:
		"指定の分のタイマーを掛け、その結果から秒を決めて、二つ目のタイマーを掛ける",
	useWhen: [
		"タイマーを掛けて、続けてもう一つタイマーを掛けたい",
		"二段階のタイマーを順に掛けたい",
	],
	avoidWhen: [],
	inputs: {
		minutes: {
			type: "integer",
			description: "一つ目のタイマーの分",
			required: true,
			minimum: 1,
			maximum: 60,
		},
	},
	steps: [
		{
			id: "first",
			kind: "toolchain",
			title: "一つ目のタイマー",
			toolchain: "timers.manage",
			request: "${inputs.minutes}分のタイマーを掛けてください",
		},
		{
			id: "seconds",
			kind: "extract",
			title: "秒を決める",
			from: ["${steps.first.summary}"],
			instruction: "二つ目のタイマーの秒",
			schema: { type: "integer", minimum: 1, maximum: 600 },
		},
		{
			id: "second",
			kind: "toolchain",
			title: "二つ目のタイマー",
			toolchain: "timers.manage",
			request: "${steps.seconds.value}秒のタイマーを掛けてください",
			uses: ["first"],
		},
	],
	answer: "二つ目は${steps.seconds.value}秒です。",
	tests: [
		{
			utterance: "5分のタイマーを掛けて、続けてもう一つ掛けて",
			inputs: { minutes: 5 },
			stepResults: {
				first: { summary: "300秒" },
				seconds: { value: 30 },
				second: { summary: "30秒" },
			},
			expect: { "steps.seconds.value": 30 },
		},
	],
};

const TEXT = "5分のタイマーを掛けて、続けてもう一つタイマーを掛けて";

/** The command of each timer step: the minutes or seconds its request names. */
function timerCommand(messages: Array<{ role: string; content: string }>) {
	const data = JSON.parse(
		messages.filter((m) => m.role === "user").at(-1)!.content,
	) as {
		request: string;
	};
	const minutes = /(\d+)分/.exec(data.request);
	const seconds = /(\d+)秒/.exec(data.request);
	return JSON.stringify({
		action: "invoke",
		tool: "timer.start",
		arguments: {
			durationSeconds: minutes
				? Number(minutes[1]) * 60
				: Number(seconds?.[1] ?? 1),
		},
	});
}

async function setup(extract: () => unknown) {
	const h = await harness({
		timers: true,
		pipelines: true,
		command: timerCommand,
		extract,
		firstRound: (tools) =>
			tools.some((t) => t.function.name === "pipeline_timer_relay")
				? {
						name: "pipeline_timer_relay",
						args: {
							kind: "action",
							freshness: "not_live",
							impact: "create",
							approved: false,
							announcement: "二つのタイマーを順に掛けます。",
							minutes: 5,
							minutes_quote: "5分のタイマー",
						},
					}
				: undefined,
	});
	return { h, pipelines: h.pipelines };
}

const timers = (h: Awaited<ReturnType<typeof harness>>) =>
	h.store.read(
		(db) =>
			db
				.query(
					"SELECT duration_seconds AS s, origin_message_id AS m FROM timers ORDER BY rowid",
				)
				.all() as Array<{ s: number; m: string }>,
	);
const execution = (h: Awaited<ReturnType<typeof harness>>) =>
	h.store.read(
		(db) =>
			db.query("SELECT state, result_json FROM agent_executions").get() as {
				state: string;
				result_json: string | null;
			} | null,
	);

test("a published pipeline is a new revision of an ordinary toolchain; an unchanged one is left as it is", async () => {
	const { h, pipelines } = await setup(() => 30);
	try {
		const first = await pipelines.publish(relay);
		expect(first).toEqual({
			ok: true,
			toolchainId: "pipeline.timer-relay",
			toolchainRevisionId: "toolchain:pipeline.timer-relay@1",
			functionName: "pipeline_timer_relay",
			unchanged: false,
		});
		expect(await pipelines.publish(relay)).toMatchObject({ unchanged: true });
		const changed = { ...relay, title: "二段のタイマー" };
		expect(await pipelines.publish(changed)).toMatchObject({
			toolchainRevisionId: "toolchain:pipeline.timer-relay@2",
		});
		const entry = h.store.read((db) =>
			h.routing
				.catalogInTransaction(db)
				.find((e) => e.id === "pipeline.timer-relay"),
		);
		expect(entry?.revisionId).toBe("toolchain:pipeline.timer-relay@2");
		expect(entry?.runtime.execution).toBe("pipeline");
		// A step that names no registered toolchain is refused by place and rule, and nothing is registered.
		const broken = structuredClone(relay) as any;
		broken.id = "broken-relay";
		broken.steps[2].toolchain = "timers.gone";
		expect(await pipelines.publish(broken)).toEqual({
			ok: false,
			issues: [{ pointer: "/steps/2/toolchain", rule: "unknown_toolchain" }],
		});
		const response = await h.request("/api/pipelines/check", {
			definition: broken,
		});
		expect(response.status).toBe(422);
		expect(pipelines.fixture(relay, 0)).toMatchObject({
			ok: true,
			outcome: { passed: true, answer: "二つ目は30秒です。" },
		});
	} finally {
		await h.close();
	}
});

test("the first round picks the pipeline with its inputs; the host runs each step as a child, and the finished run is checked against the request", async () => {
	const { h, pipelines } = await setup(() => 30);
	try {
		expect((await pipelines.publish(relay)).ok).toBe(true);
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: TEXT,
		});
		await waitFor(() => execution(h)?.state === "completed", {
			timeout: 15000,
		});
		expect(h.dialogue.answerText(run.id)).toBe(
			"二つのタイマーを順に掛けます。",
		);
		// Both timers stand on the user's own message; the second takes the value the extract step gave.
		expect(timers(h)).toEqual([
			{ s: 300, m: run.inputMessageId },
			{ s: 30, m: run.inputMessageId },
		]);
		const steps = h.store.read((db) =>
			(
				db
					.query(
						"SELECT input_json FROM agent_execution_steps ORDER BY ordinal",
					)
					.all() as Array<{ input_json: string }>
			).map(
				(s) =>
					JSON.parse(s.input_json) as {
						request: string;
						refs: Array<{ ref: string }>;
					},
			),
		);
		expect(steps.map((s) => s.request)).toEqual([
			"5分のタイマーを掛けてください",
			"30秒のタイマーを掛けてください",
		]);
		// `uses` hands the earlier step's result to the later one as a reference.
		expect(steps[1]!.refs.map((r) => r.ref)).toHaveLength(1);
		expect(JSON.parse(execution(h)!.result_json!)).toMatchObject({
			status: "completed",
			summary: "二つ目は30秒です。",
			fulfilled: ["一つ目のタイマー", "二つ目のタイマー"],
			missing: [],
		});
		// The notice of the finished run is answered, and that answer is checked against the user's request.
		await waitFor(() => h.completionContexts.length > 0, { timeout: 15000 });
		expect(h.completionContexts[0]).toContain(TEXT.replace(/"/g, '\\"'));
	} finally {
		await h.close();
	}
});

test("a value that does not fit gets one repair; then the run stops with what was done", async () => {
	let extracts = 0;
	const { h, pipelines } = await setup(() => {
		extracts++;
		return 0;
	});
	try {
		expect((await pipelines.publish(relay)).ok).toBe(true);
		await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: TEXT,
		});
		await waitFor(() => execution(h)?.state === "partial", { timeout: 15000 });
		expect(extracts).toBe(2);
		expect(timers(h).map((t) => t.s)).toEqual([300]);
		expect(JSON.parse(execution(h)!.result_json!)).toMatchObject({
			status: "partial",
			code: "pipeline_extract_invalid_too_small",
			fulfilled: ["一つ目のタイマー"],
			missing: ["二つ目のタイマー"],
		});
	} finally {
		await h.close();
	}
});

test("a quote that is not the user's words goes back for the structural repair", async () => {
	const { h, pipelines } = await setup(() => 30);
	try {
		expect((await pipelines.publish(relay)).ok).toBe(true);
		const card = h.store.read((db) =>
			h.routing.cardInTransaction(db, "toolchain:pipeline.timer-relay@1"),
		);
		expect(card?.pipeline?.outline).toBe("一つ目のタイマー→二つ目のタイマー");
		expect(
			card?.pipeline?.parse({ minutes: 5, minutes_quote: "七分" }, TEXT),
		).toEqual({
			ok: false,
			issues: [{ path: "minutes_quote", code: "quote_not_in_request" }],
		});
	} finally {
		await h.close();
	}
});

test("the names a pipeline may not give its inputs are exactly the first round's own fields", () => {
	const tools = analysisTools([
		{
			id: "pipeline.x",
			revisionId: "toolchain:pipeline.x@1",
			functionName: "pipeline_x",
			title: "x",
			summary: "x",
			useWhen: [],
			redirects: [],
			execution: "pipeline",
			pipeline: {
				parameters: { type: "object", properties: {}, required: [] },
				outline: "a→b",
				parse: () => ({ ok: true, value: {} }),
			},
			score: { rank: 1, ftsRank: null, similarity: null, fromHistory: false },
		},
	]);
	const own = tools.find((t) => t.function.name === "pipeline_x")!;
	expect(
		Object.keys(
			(own.function.parameters as { properties: Record<string, unknown> })
				.properties,
		).sort(),
	).toEqual([...RESERVED_INPUT_NAMES].sort());
});

test("a pipeline id that names another toolchain is refused; a revision published during a run does not stop it", async () => {
	let republished: Promise<unknown> | undefined;
	const { h, pipelines } = await setup(() => {
		// A later revision of the same pipeline is published while the run is between its steps.
		republished ??= pipelines.publish({
			...relay,
			title: "直した二段のタイマー",
		});
		return 30;
	});
	try {
		// The studio itself is `pipeline.studio`.
		expect(await pipelines.publish({ ...relay, id: "studio" })).toEqual({
			ok: false,
			issues: [{ pointer: "/id", rule: "id_reserved" }],
		});
		expect((await pipelines.publish(relay)).ok).toBe(true);
		await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: TEXT,
		});
		await waitFor(() => execution(h)?.state === "completed", {
			timeout: 15000,
		});
		expect(await republished).toMatchObject({
			toolchainRevisionId: "toolchain:pipeline.timer-relay@2",
		});
		expect(timers(h).map((t) => t.s)).toEqual([300, 30]);
	} finally {
		await h.close();
	}
});
