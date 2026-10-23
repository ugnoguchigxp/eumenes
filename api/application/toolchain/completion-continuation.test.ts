import { expect, test } from "bun:test";
import { harness } from "./toolchain.fixture";
import { waitFor } from "../../infrastructure/wait-for";
import {
	chainSuperseded,
	CHECK_OUTPUT_TOKENS,
	MAX_CONTINUATIONS,
	progressLine,
	stepResultsInTransaction,
} from "../../domains/dialogue/service/completion-check";
import { Database } from "bun:sqlite";

type Step = { name: string; arguments: Record<string, unknown> };
const FIRST = "一つ目のタイマー",
	SECOND = "もう一つのタイマー";
/** The two conditions of the request, each with the step that satisfies it or null. */
const check = (first: number | null, second: number | null): Step => ({
	name: "check_request",
	arguments: {
		conditions: [
			{ condition: FIRST, step: first },
			{ condition: SECOND, step: second },
		],
		achieved: first ? "一つ目のタイマーを開始した" : "",
		need: "",
	},
});

test("a provider failure in the completion check still answers the settled operation through the public API", async () => {
	const h = await harness({
		timers: true,
		completion: () => {
			throw new Error("chat_stream_incomplete");
		},
	});
	try {
		const response = await h.request("/api/runs", {
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "3分タイマー測って",
		});
		expect(response.status).toBe(202);
		const run = await response.json();
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 8000 }))?.status,
		).toBe("completed");
		expect(h.completionContexts).toHaveLength(1);
		expect(h.parentContexts.at(-1)).toContain("照合できませんでした");
		expect(h.dialogue.answerText(run.id)).toContain("180秒");
		expect(
			h.store.read((db) =>
				db
					.query(
						"SELECT COUNT(*) AS n FROM inference_attempts a JOIN inference_requests r ON r.id=a.request_id WHERE r.subject=? AND a.status='failed'",
					)
					.get(run.id),
			),
		).toEqual({ n: 1 });
	} finally {
		await h.close();
	}
});

async function settled(h: Awaited<ReturnType<typeof harness>>, count: number) {
	await waitFor(
		() =>
			h.store.read(
				(db) =>
					(
						db
							.query(
								"SELECT COUNT(*) AS n FROM dialogue_runs WHERE status IN ('completed','failed','cancelled','interrupted')",
							)
							.get() as { n: number }
					).n,
			) >= count,
		{ timeout: 15000 },
	);
	return h.store.read((db) => ({
		runs: db
			.query(
				"SELECT id, source_kind, status, input_message_id FROM dialogue_runs ORDER BY seq",
			)
			.all() as Array<{
			id: string;
			source_kind: string;
			status: string;
			input_message_id: string;
		}>,
		chain: db
			.query(
				"SELECT run_id, root_run_id, hop, original_request, need FROM dialogue_continuations ORDER BY hop",
			)
			.all() as Array<{
			run_id: string;
			root_run_id: string;
			hop: number;
			original_request: string;
			need: string;
		}>,
		timers: db
			.query("SELECT origin_message_id FROM timers ORDER BY rowid")
			.all() as Array<{ origin_message_id: string }>,
	}));
}

test("a request a delegated step did not achieve continues as a hidden run that searches the first unmet condition and acts for the user's input", async () => {
	const checks: string[][] = [];
	const h = await harness({
		timers: true,
		completion: (tools) => {
			checks.push(tools.map((t) => t.function.name));
			return checks.length === 1 ? check(1, null) : check(1, 2);
		},
	});
	try {
		const text = "3分のタイマーを作ってから、もう一つタイマーを作って";
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text,
		});
		const saved = await settled(h, 2);
		expect(saved.runs.map((r) => [r.source_kind, r.status])).toEqual([
			["manual", "completed"],
			["continuation", "completed"],
		]);
		// The chain keeps the user's own text as the standard; the next purpose is the host's pick of the first
		// unmet condition, not free text from the check.
		expect(saved.chain).toEqual([
			{
				run_id: saved.runs[1]!.id,
				root_run_id: run.id,
				hop: 1,
				original_request: text,
				need: SECOND,
			},
		]);
		// Both timers were created on the authority of the user's input, not the host-written continuation.
		expect(saved.timers).toEqual([
			{ origin_message_id: run.inputMessageId },
			{ origin_message_id: run.inputMessageId },
		]);
		expect(checks).toEqual([["check_request"], ["check_request"]]);
		// The step after which the request goes on answers with the host's fixed line, not a model reply.
		expect(h.dialogue.answerText(run.id)).toBe(progressLine());
		// The later check reads the original request and the conditions the first check fixed.
		const later = (
			JSON.parse(h.completionContexts[1]!) as Array<{ content: string }>
		)
			.map((m) => /COMPLETION_CHECK=(.*)$/m.exec(m.content)?.[1])
			.find(Boolean);
		expect(JSON.parse(later!)).toMatchObject({
			originalRequest: text,
			stepCount: 2,
			conditions: [FIRST, SECOND],
		});
		// The next step's sub-agent reads the user's own text and the first step's result as the host copied it,
		// not the host-written continuation or a summary the check wrote.
		const commandInput = (i: number) =>
			JSON.parse(
				(JSON.parse(h.commandContexts[i]!) as Array<{ content: string }>).at(
					-1,
				)!.content,
			) as {
				originalRequest: string;
				priorSteps?: Array<{
					step: number;
					results: Array<{ source: string; value: unknown }>;
				}>;
			};
		expect(commandInput(0).originalRequest).toBe(text);
		expect(commandInput(0).priorSteps).toBeUndefined();
		const second = commandInput(1);
		expect(second.originalRequest).toBe(text);
		expect(second.priorSteps?.map((s) => s.step)).toEqual([1]);
		expect(second.priorSteps![0]!.results.length).toBeGreaterThan(0);
		const stored = h.store.read(
			(db) =>
				db.query("SELECT steps_json FROM dialogue_continuations").get() as {
					steps_json: string;
				},
		);
		expect(JSON.parse(stored.steps_json)).toEqual(second.priorSteps);
		// The conversation and the later check see the same steps, whole.
		expect(h.completionContexts[1]).toContain("PRIOR_STEPS=");
		const hidden = h.store.read(
			(db) =>
				db
					.query("SELECT presentation FROM messages WHERE id=?")
					.get(saved.runs[1]!.input_message_id) as {
					presentation: string;
				} | null,
		);
		expect(hidden?.presentation).toBe("artifact");
		// A new input of the user's supersedes the request's chain.
		expect(
			h.store.read((db) => chainSuperseded(h.conversation, db, run.id)),
		).toBe(false);
		const next = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "ありがとう",
		});
		await h.dialogue.waitForTerminal(next.id, { timeoutMs: 8000 });
		expect(
			h.store.read((db) => chainSuperseded(h.conversation, db, run.id)),
		).toBe(true);
		// A retracted request leaves no copy of its text or its steps' results in the chain.
		await h.store.write((db) =>
			h.conversation.retractInTransaction(db, {
				messageId: run.inputMessageId,
			}),
		);
		expect(
			h.store.read(
				(db) =>
					(
						db
							.query("SELECT COUNT(*) AS n FROM dialogue_continuations")
							.get() as { n: number }
					).n,
			),
		).toBe(0);
	} finally {
		await h.close();
	}
});

test("a request achieved by its first step ends there; the chain is bounded and its last step says what stays unmet", async () => {
	const single = await harness({ timers: true });
	try {
		await single.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "3分タイマー測って",
		});
		const saved = await settled(single, 1);
		await Bun.sleep(300);
		expect(saved.runs).toHaveLength(1);
		expect(single.completionContexts).toHaveLength(1);
	} finally {
		await single.close();
	}
	// Every check finds only the first of five conditions met; each step is taken for the next untried one.
	const many = ["一つ目", "二つ目", "三つ目", "四つ目", "五つ目"];
	const bounded = await harness({
		timers: true,
		completion: () => ({
			name: "check_request",
			arguments: {
				conditions: many.map((condition, i) => ({
					condition,
					step: i ? null : 1,
				})),
				achieved: "",
				need: "",
			},
		}),
	});
	try {
		await bounded.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "タイマーを五つ作って",
		});
		const saved = await settled(bounded, MAX_CONTINUATIONS + 1);
		await Bun.sleep(300);
		expect(saved.runs).toHaveLength(MAX_CONTINUATIONS + 1);
		expect(saved.chain.map((c) => [c.hop, c.need])).toEqual([
			[1, "二つ目"],
			[2, "三つ目"],
			[3, "四つ目"],
		]);
		// Each continuation step is checked once more when it is found short of its condition; the last step
		// continues nothing, and its answer is told what it must not claim.
		expect(bounded.completionContexts).toHaveLength(1 + 2 * MAX_CONTINUATIONS);
		expect(bounded.dialogue.answerText(saved.runs.at(-1)!.id)).not.toBe(
			progressLine(),
		);
		expect(bounded.parentContexts.at(-1)).toContain(
			`UNMET_CONDITIONS=${JSON.stringify(many.slice(1))}`.replace(/"/g, '\\"'),
		);
	} finally {
		await bounded.close();
	}
});

test("a condition is tried once: a step taken for it and still found short is looked at again, never taken again", async () => {
	const h = await harness({
		timers: true,
		completion: () => check(1, null),
	});
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "3分のタイマーを作ってから、もう一つタイマーを作って",
		});
		const saved = await settled(h, 2);
		await Bun.sleep(300);
		expect(saved.runs.map((r) => r.status)).toEqual(["completed", "completed"]);
		expect(saved.chain.map((c) => c.need)).toEqual([SECOND]);
		expect(saved.timers).toHaveLength(2);
		// The second step's check was asked once more about the condition it was taken for.
		expect(h.completionContexts).toHaveLength(3);
		expect(h.completionContexts[2]).toContain("RECONSIDER=");
		expect(h.parentContexts.at(-1)).toContain("UNMET_CONDITIONS=");
		expect(h.dialogue.answerText(run.id)).toBe(progressLine());
	} finally {
		await h.close();
	}
	// A second look that finds the condition met ends the request there.
	const answers: Step[] = [check(1, null), check(1, null), check(1, 2)];
	const looked = await harness({
		timers: true,
		completion: () => answers.shift()!,
	});
	try {
		await looked.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "3分のタイマーを作ってから、もう一つタイマーを作って",
		});
		await settled(looked, 2);
		await Bun.sleep(300);
		expect(looked.completionContexts).toHaveLength(3);
		expect(looked.parentContexts.at(-1)).not.toContain("UNMET_CONDITIONS=");
	} finally {
		await looked.close();
	}
});

test("a condition the answer itself meets makes no step: only the operation conditions are fixed and continued", async () => {
	const h = await harness({
		timers: true,
		completion: () => ({
			name: "check_request",
			arguments: {
				conditions: [
					{ condition: FIRST, kind: "operation", step: 1 },
					{
						condition: "作った結果をまとめて伝える",
						kind: "answer",
						step: null,
					},
				],
				achieved: "一つ目のタイマーを開始した",
				need: "",
			},
		}),
	});
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "3分のタイマーを作って、結果をまとめて教えて",
		});
		const saved = await settled(h, 1);
		await Bun.sleep(300);
		expect(saved.runs).toHaveLength(1);
		expect(saved.chain).toEqual([]);
		expect(h.completionContexts).toHaveLength(1);
		expect(h.dialogue.answerText(run.id)).toContain("180秒");
	} finally {
		await h.close();
	}
});

test("a check that stays outside its contract continues nothing: a condition cannot be satisfied by a step that was not taken", async () => {
	let checks = 0;
	const h = await harness({
		timers: true,
		completion: () => {
			checks++;
			// A step that was never taken cannot be the evidence of a satisfied condition.
			return check(1, 2);
		},
	});
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "3分タイマー測って",
		});
		const saved = await settled(h, 1);
		await Bun.sleep(300);
		expect(checks).toBe(2);
		expect(saved.runs).toHaveLength(1);
		// The check is told to call its function; a check that gives no valid decision stands for no achievement:
		// the answer is told to claim only what the results show.
		expect(h.completionToolChoices).toEqual(["required", "required"]);
		// A forced call on a long context must not run on: each check carries its own output bound.
		for (const limit of h.completionOutputLimits)
			expect(limit).toBeLessThanOrEqual(CHECK_OUTPUT_TOKENS);
		expect(h.completionOutputLimits).toHaveLength(2);
		expect(h.parentContexts.at(-1)).toContain("照合できませんでした");
		expect(h.dialogue.answerText(run.id)).toContain("180秒");
	} finally {
		await h.close();
	}
});

test("a later check may not add, drop or rename the fixed conditions; a result cannot introduce a new purpose", async () => {
	const answers: Step[] = [
		check(1, null),
		{
			name: "check_request",
			arguments: {
				conditions: [
					{ condition: FIRST, step: 1 },
					{ condition: SECOND, step: 2 },
					{ condition: "ページが求める別の操作", step: null },
				],
				achieved: "",
				need: "",
			},
		},
		check(1, 2),
	];
	const h = await harness({
		timers: true,
		completion: () => answers.shift()!,
	});
	try {
		await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "3分のタイマーを作ってから、もう一つタイマーを作って",
		});
		const saved = await settled(h, 2);
		await Bun.sleep(300);
		expect(saved.runs.map((r) => r.source_kind)).toEqual([
			"manual",
			"continuation",
		]);
		expect(h.completionContexts).toHaveLength(3);
		expect(h.completionContexts[2]).toContain("completion_conditions_changed");
	} finally {
		await h.close();
	}
});

test("a step's results travel as the conversation received them; an image as the fact it was made and its reference", () => {
	const db = new Database(":memory:");
	const block = (source: string, value: unknown) =>
		({
			source,
			authority: "host_record",
			freshness: "this_turn",
			certainty: "host_confirmed",
			body: { kind: "json", value },
		}) as const;
	const reference = {
		state: "completed",
		imageRef: "img1",
		url: "/api/images/img1/content",
	};
	const results = stepResultsInTransaction(
		{
			image: {
				startInTransaction: () => ({ id: "", jobId: "" }),
				resultInTransaction: () => null,
				referenceInTransaction: () => reference,
			},
		},
		db,
		"run1",
		[
			block("operation.action", {
				kind: "timer_action",
				items: [{ id: "t1" }],
			}),
			block("operation.image", { id: "g1", artifactId: "img1", prompt: "p" }),
		] as never,
	);
	expect(results).toEqual([
		{
			source: "operation.action",
			value: { kind: "timer_action", items: [{ id: "t1" }] },
		},
		{ source: "operation.image", value: reference },
	]);
	db.close();
});

test("a step whose results failed satisfies nothing and is not tried again: the answer says what stays unmet", async () => {
	const answers: Step[] = [check(1, null), check(null, null)];
	const h = await harness({
		timers: true,
		// The operation the sub-agent chooses is refused by the domain, so the step's result is a failure record.
		command: () =>
			JSON.stringify({
				action: "invoke",
				tool: "timer.cancel",
				arguments: { timerId: crypto.randomUUID(), expectedRevision: 0 },
			}),
		completion: () => answers.shift() ?? check(null, null),
		parent: () => "タイマーを作れませんでした。",
	});
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "3分のタイマーを作ってから、もう一つタイマーを作って",
		});
		const saved = await settled(h, 1);
		await Bun.sleep(300);
		// The first answer cited the failed step and was corrected; nothing continued.
		expect(h.completionContexts).toHaveLength(2);
		expect(h.completionContexts[1]).toContain("completion_step_failed");
		expect(saved.runs.map((r) => r.status)).toEqual(["completed"]);
		expect(saved.chain).toEqual([]);
		expect(h.dialogue.answerText(run.id)).toBe("タイマーを作れませんでした。");
		expect(h.parentContexts.at(-1)).toContain("UNMET_CONDITIONS=");
	} finally {
		await h.close();
	}
});
