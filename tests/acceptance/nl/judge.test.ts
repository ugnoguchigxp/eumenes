import { describe, expect, test } from "bun:test";
import { judge } from "../../../scripts/nl-acceptance/judge";
import type {
	Criteria,
	HostSnapshot,
	RunEvidence,
	Termination,
} from "../../../scripts/nl-acceptance/types";
import { clockCandidates } from "../../../scripts/nl-acceptance/clock";
import { criteriaOf, MAIN_ID, synthMain, T0 } from "./synth";

const main = criteriaOf("timer-ui-purpose-01");
const byId = (r: ReturnType<typeof judge>, id: string) =>
	r.criteria.find((c) => c.id === id)!;

describe("main case: a correct run", () => {
	test("is judged success only from host state, receipts and screen readings", () => {
		const r = judge(main, synthMain());
		expect(r.criteria.map((c) => `${c.id}:${c.status}:${c.code}`)).toEqual([
			"C1:met:new_timers_match",
			"C2:met:host_and_screen_decrease",
			"C3:met:host_and_screen_stable",
			"C4:met:resumed_same_timer",
			"C5:met:no_extra_side_effects",
		]);
		expect(r.verdict).toBe("success");
		expect(r.failureClass).toBeNull();
	});
});

describe("main case: injected faults are detected", () => {
	test("a double start is a failure (C1 extra_timers, C5)", () => {
		const r = judge(main, synthMain({ doubleStart: true }));
		expect(r.verdict).toBe("failure");
		// Two starts may be the tester's own doing; the class waits for the review.
		expect(r.failureClass).toBe("undetermined");
		expect(byId(r, "C1")).toMatchObject({
			status: "violated",
			code: "extra_timers",
		});
		expect(byId(r, "C5").status).toBe("violated");
		expect(r.reviewRequired).toBe(true);
	});

	test("a double start that reused one timer still shows two started receipts", () => {
		const ev = synthMain();
		ev.receipts.push({
			atMs: T0 + 8000,
			action: "started",
			operationId: "20000000-0000-4000-8000-0000000000ff",
			timerId: MAIN_ID,
			revision: 0,
			httpStatus: 201,
		});
		const r = judge(main, ev);
		expect(r.verdict).toBe("failure");
		expect(byId(r, "C1").code).toBe("duplicate_start");
	});

	test("180 minutes instead of 180 seconds is a failure (wrong_duration)", () => {
		const r = judge(main, synthMain({ durationSeconds: 10800 }));
		expect(r.verdict).toBe("failure");
		expect(byId(r, "C1")).toMatchObject({
			status: "violated",
			code: "wrong_duration",
		});
		expect(byId(r, "C1").detail).toContain("10800");
	});

	test("a success display with no timer in the host is a failure (fake_success_display)", () => {
		const r = judge(main, synthMain({ fakeSuccess: true }));
		expect(r.verdict).toBe("failure");
		expect(r.failureClass).toBe("product");
		expect(byId(r, "C1")).toMatchObject({
			status: "violated",
			code: "fake_success_display",
		});
	});

	test("a seeded timer that changed is a failure (other_timer_modified)", () => {
		const r = judge(main, synthMain({ otherTimerModified: true }));
		expect(r.verdict).toBe("failure");
		expect(byId(r, "C5")).toMatchObject({
			status: "violated",
			code: "other_timer_modified",
		});
	});

	test("a remaining time that keeps running while paused is a failure", () => {
		const r = judge(main, synthMain({ driftWhilePaused: true }));
		expect(r.verdict).toBe("failure");
		expect(byId(r, "C3").code).toBe("remaining_changed_while_paused");
	});

	test("the tester's reason or claim never turns a failing run into a success", () => {
		const ev = synthMain({ fakeSuccess: true });
		ev.termination = {
			reason: "done",
			detail: "3分のタイマーを作り、一時停止と再開もできました",
		};
		expect(judge(main, ev).verdict).toBe("failure");
	});
});

describe("termination decides inconclusive runs", () => {
	test("give_up is inconclusive with failureClass tester", () => {
		const r = judge(
			main,
			synthMain({ endAtSeconds: 10, termination: { reason: "give_up" } }),
		);
		expect(r.verdict).toBe("inconclusive");
		expect(r.failureClass).toBe("tester");
		expect(r.reasonCode).toBe("give_up");
	});

	for (const reason of [
		"budget_wall",
		"budget_actions",
		"budget_model_calls",
		"budget_cost",
	] as const)
		test(`${reason} is inconclusive (tester), even if the host looks complete`, () => {
			const r = judge(main, synthMain({ termination: { reason } }));
			expect(r.verdict).toBe("inconclusive");
			expect(r.failureClass).toBe("tester");
		});

	test("tester_error and forbidden_action are inconclusive (tester)", () => {
		for (const reason of ["tester_error", "forbidden_action"] as const) {
			const r = judge(main, synthMain({ termination: { reason } }));
			expect([r.verdict, r.failureClass]).toEqual(["inconclusive", "tester"]);
		}
	});

	test("driver, environment and precondition stops are inconclusive (environment)", () => {
		for (const reason of [
			"driver_error",
			"environment_error",
			"precondition_failed",
		] as const) {
			const r = judge(main, synthMain({ termination: { reason } }));
			expect([r.verdict, r.failureClass]).toEqual([
				"inconclusive",
				"environment",
			]);
		}
	});

	test("a concrete violation before the tester gives up is not blamed on the product", () => {
		const r = judge(
			main,
			synthMain({ doubleStart: true, termination: { reason: "give_up" } }),
		);
		expect(r.verdict).toBe("failure");
		expect(r.failureClass).toBe("undetermined");
	});

	test("done without ever pausing is a failure with an undetermined class", () => {
		const r = judge(main, synthMain({ endAtSeconds: 14 }));
		expect(r.verdict).toBe("failure");
		expect(r.failureClass).toBe("undetermined");
		expect(byId(r, "C3").code).toBe("never_paused");
	});

	test("a screen with no readable clock leaves the run inconclusive for review", () => {
		const r = judge(main, synthMain({ unreadableScreen: true }));
		expect(r.verdict).toBe("inconclusive");
		expect(r.reasonCode).toBe("evidence_gap");
		expect(byId(r, "C2").code).toBe("screen_clock_unreadable");
	});

	test("no host observation at all is an environment problem", () => {
		const ev: RunEvidence = { ...synthMain(), hostSeries: [] };
		const r = judge(main, ev);
		expect([r.verdict, r.failureClass]).toEqual([
			"inconclusive",
			"environment",
		]);
	});
});

describe("criteria hygiene", () => {
	test("an unknown check makes the run inconclusive with failureClass criteria", () => {
		const broken: Criteria = {
			...main,
			items: [{ ...main.items[0]!, check: "no-such-check" }],
		};
		const r = judge(broken, synthMain());
		expect([r.verdict, r.failureClass]).toEqual(["inconclusive", "criteria"]);
	});

	test("clock candidates read mm:ss, h:mm:ss and Japanese units", () => {
		expect(clockCandidates("残り 2:59")).toContain(179);
		expect(clockCandidates("0:02:59")).toContain(179);
		expect(clockCandidates("2分59秒")).toContain(179);
		expect(clockCandidates("1時間2分3秒")).toContain(3723);
		expect(clockCandidates("タイマー")).toEqual([]);
	});
});

function snap(
	seq: number,
	timers: HostSnapshot["timers"],
	interactions: HostSnapshot["interactions"] = null,
): HostSnapshot {
	return {
		seq,
		atMs: T0 + seq * 1000,
		serverNowMs: T0 + seq * 1000,
		timers,
		interactions,
	};
}
const tea = (revision: number, state: "active" | "paused" | "cancelled") => ({
	id: "10000000-0000-4000-8000-0000000000bb",
	revision,
	state,
	label: "お茶",
	durationSeconds: 900,
	dueAt: new Date(T0 + 900_000).toISOString(),
	remainingSeconds: 900,
	originRunId: null,
});
const evidenceOf = (
	caseId: string,
	hostSeries: HostSnapshot[],
	termination: Termination = { reason: "done" },
	extra: Partial<RunEvidence> = {},
): RunEvidence => ({
	caseId,
	hostSeries,
	receipts: [],
	screens: [
		{ seq: 1, atMs: T0 + 5000, text: "- status: タイマーを取り消しました" },
	],
	reloads: [],
	faultsTriggered: [],
	termination,
	...extra,
});

describe("other cases", () => {
	test("cancel: paused is not a cancellation, cancelled is", () => {
		const c = criteriaOf("timer-conversation-cancel-01");
		const paused = judge(
			c,
			evidenceOf(c.caseId, [
				snap(0, [tea(0, "active")]),
				snap(5, [tea(1, "paused")]),
			]),
		);
		expect(paused.verdict).toBe("failure");
		expect(byId(paused, "C1").code).toBe("state_not_reached");
		const cancelled = judge(
			c,
			evidenceOf(
				c.caseId,
				[snap(0, [tea(0, "active")]), snap(5, [tea(1, "cancelled")])],
				{ reason: "done" },
				{
					receipts: [
						{
							atMs: T0 + 5000,
							action: "cancelled",
							operationId: "20000000-0000-4000-8000-000000000009",
							timerId: "10000000-0000-4000-8000-0000000000bb",
							revision: 1,
							httpStatus: 200,
						},
					],
				},
			),
		);
		expect(cancelled.verdict).toBe("success");
	});

	test("cancel: creating a new timer instead is detected", () => {
		const c = criteriaOf("timer-conversation-cancel-01");
		const extra = {
			...tea(0, "active"),
			id: "10000000-0000-4000-8000-0000000000cc",
			label: "新規",
		};
		const r = judge(
			c,
			evidenceOf(c.caseId, [
				snap(0, [tea(0, "active")]),
				snap(5, [tea(1, "cancelled"), extra]),
			]),
		);
		expect(r.verdict).toBe("failure");
		expect(byId(r, "C2").code).toBe("extra_timers");
	});

	test("network loss: a fault that never fired invalidates the run (environment)", () => {
		const c = criteriaOf("timer-network-loss-01");
		const r = judge(c, evidenceOf(c.caseId, [snap(0, []), snap(5, [])]));
		expect([r.verdict, r.failureClass]).toEqual([
			"inconclusive",
			"environment",
		]);
	});

	test("network loss: a resend with a new id (two timers) is a failure", () => {
		const c = criteriaOf("timer-network-loss-01");
		const one = {
			...tea(0, "active"),
			label: "タイマー",
			durationSeconds: 180,
		};
		const two = { ...one, id: "10000000-0000-4000-8000-0000000000dd" };
		const r = judge(
			c,
			evidenceOf(
				c.caseId,
				[snap(0, []), snap(5, [one, two])],
				{ reason: "done" },
				{
					faultsTriggered: [{ kind: "drop-response", atMs: T0 + 3000 }],
				},
			),
		);
		expect(r.verdict).toBe("failure");
		expect(byId(r, "C1").code).toBe("extra_timers");
	});

	test("question continuation: waiting_input then completed across a reload", () => {
		const c = criteriaOf("timer-question-continuation-01");
		const timer = {
			...tea(0, "active"),
			label: "タイマー",
			durationSeconds: 180,
			originRunId: "run-2",
		};
		const waiting = {
			id: "i1",
			status: "waiting_input",
			questionCount: 1,
			hasReceiptRef: false,
		};
		const done = {
			id: "i1",
			status: "completed",
			questionCount: 1,
			hasReceiptRef: true,
		};
		const series = [
			snap(0, [], []),
			snap(2, [], [waiting]),
			snap(6, [timer], [done]),
		];
		const ok = judge(
			c,
			evidenceOf(
				c.caseId,
				series,
				{ reason: "done" },
				{ reloads: [T0 + 4000] },
			),
		);
		expect(ok.verdict).toBe("success");
		const noReload = judge(c, evidenceOf(c.caseId, series));
		expect(byId(noReload, "C2").code).toBe("no_reload_while_waiting");
		const unread = judge(
			c,
			evidenceOf(c.caseId, [snap(0, []), snap(6, [timer])]),
		);
		expect([unread.verdict, unread.failureClass]).toEqual([
			"inconclusive",
			"environment",
		]);
	});
});
