import { expect, test } from "bun:test";
import { harness } from "./toolchain.fixture";
import { waitFor } from "../../infrastructure/wait-for";
import {
	chainSuperseded,
	MAX_CONTINUATIONS,
	progressLine,
} from "../../domains/dialogue/service/completion-check";

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
	} finally {
		await h.close();
	}
});

test("a request achieved by its first step ends there; the chain is bounded and its last step is not checked", async () => {
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
	const bounded = await harness({
		timers: true,
		// Every check reports the second condition still unmet.
		completion: () => check(1, null),
	});
	try {
		await bounded.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "タイマーを何個も作って",
		});
		const saved = await settled(bounded, MAX_CONTINUATIONS + 1);
		await Bun.sleep(300);
		expect(saved.runs).toHaveLength(MAX_CONTINUATIONS + 1);
		expect(saved.chain.map((c) => c.hop)).toEqual([1, 2, 3]);
		expect(bounded.completionContexts).toHaveLength(MAX_CONTINUATIONS);
	} finally {
		await bounded.close();
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
