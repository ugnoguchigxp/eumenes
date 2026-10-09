import { expect, test } from "bun:test";
import type { Prediction } from "eumenes-world-model";
import { ACCESS, NOW, SCOPE } from "./fixture";
import {
	memoryForgetSource,
	openLife,
	worldExternals,
	type Life,
} from "./lifecycle-fixture";
import { BASE, fixtureLedger, keyOf, measured } from "./runtime-fixture";
import {
	MemoryRegistrationRejected,
	createRuntimeObservation,
	missingConditions,
	sourceKeyOf,
	type ObserveResult,
	type RuntimeObservationOptions,
} from "..";

// P4-04 / A18 / A45: runtime result observation. FIXTURE LEDGER ONLY: the
// host has no public verified execution ledger yet, so nothing here is host
// acceptance of the ledger connection.

const PREDICTION: Extract<Prediction, { kind: "quantitative" }> = {
	kind: "quantitative",
	predictionId: "pred-1",
	revision: 1,
	comparisonId: BASE.comparisonId,
	conditions: {
		subjectId: BASE.subjectId,
		metric: BASE.metric,
		unit: BASE.unit,
		statistic: BASE.statistic,
		configuration: BASE.configuration,
		inputProfile: BASE.inputProfile,
	},
	baselineRef: BASE.baselineRef,
	baselineValue: 100,
	expectedWindow: BASE.window,
	expectedDirection: "decreases",
	measurementTolerance: 2,
	origin: "plan",
};
const REF = { predictionId: "pred-1", revision: 1 };

async function ready() {
	const life = await openLife();
	expect((await life.lifecycle.recoverWorld()).status).toBe("open");
	const result = await life.world.apply({
		access: ACCESS,
		scope: SCOPE,
		operationKey: "pred-1",
		clock: NOW,
		operation: {
			kind: "prediction.register",
			input: { prediction: PREDICTION, dueAt: NOW + 1000 },
		} as never,
	});
	expect(result.status).toBe("applied");
	return life;
}

function rig(
	life: Life,
	over: Partial<RuntimeObservationOptions> = {},
	ledger = fixtureLedger(),
) {
	const registered: string[] = [];
	const observation = createRuntimeObservation({
		store: life.store,
		world: life.world,
		ledger: ledger.port,
		lifecycle: life.lifecycle,
		purpose: ACCESS.purpose,
		clock: () => NOW,
		// Memory does not know the fixture ledger's sources; the real
		// registration is exercised separately.
		register: (_db, input) => {
			registered.push(...input.dependents.map((d) => d.externalId));
			return {
				dependents: input.dependents.length,
				registered: input.dependents.length,
				unchanged: 0,
			};
		},
		...over,
	});
	return { observation, ledger, registered };
}
const observe = (
	r: ReturnType<typeof rig>,
	id: string,
	prediction = REF,
): Promise<ObserveResult> =>
	r.observation.observe({ scope: SCOPE, ledger: keyOf(id), prediction });
const count = (life: Life, table: string): number =>
	(
		life.store.read((db) =>
			db.query(`SELECT COUNT(*) AS n FROM ${table}`).get(),
		) as { n: number }
	).n;
const hostRows = (life: Life) =>
	life.store.read((db) =>
		db
			.query(
				"SELECT ledger_revision, state, outcome_id, outcome_revision, reasons FROM world_host_runtime_observation ORDER BY recorded_at_ms, ledger_revision",
			)
			.all(),
	) as {
		ledger_revision: string;
		state: string;
		outcome_id: string | null;
		outcome_revision: number | null;
		reasons: string | null;
	}[];
const verdictOf = (life: Life, r: ReturnType<typeof rig>) => {
	const out = r.observation.assess({ scope: SCOPE, prediction: PREDICTION });
	if ("status" in out) throw new Error(out.reasonCode);
	return out;
};

test("A18/A45 the same baseline and conditions: 90 supports, 110 refutes, 99 is incomparable (resolution), each only from a VERIFIED ledger version", async () => {
	for (const [value, verdict, reason] of [
		[90, "supported", undefined],
		[110, "refuted", undefined],
		[99, "incomparable", "INSUFFICIENT_RESOLUTION"],
	] as const) {
		const life = await ready();
		try {
			const r = rig(life);
			r.ledger.put("run-1", measured(value));
			const result = await observe(r, "run-1");
			expect(result.status).toBe("observed");
			const out = verdictOf(life, r);
			expect(out.assessed).toMatchObject({ status: "assessed", verdict });
			if (reason)
				expect(out.assessed).toMatchObject({
					incomparableReasons: [{ reason, count: 1 }],
				});
			expect(out.stale).toBe(0);
			// Traceable to the ledger's verified version.
			expect(out.trace).toHaveLength(1);
			expect(out.trace[0]!.ledger).toMatchObject({ revision: "r1" });
			expect(out.assessed).toMatchObject({ causalProof: false });
		} finally {
			await life.cleanup();
		}
	}
});

test("A45 a success REPORT against a failing measurement: the measurement decides, an unverified ledger entry is never an observation", async () => {
	const life = await ready();
	try {
		const r = rig(life);
		// The tool "reported success" (the model's text says done) but the ledger
		// has not verified the result: not an observation, nothing is written.
		r.ledger.put("run-1", measured(90), { verification: "unverified" });
		expect(await observe(r, "run-1")).toEqual({
			status: "refused",
			reasonCode: "NOT_VERIFIED",
		});
		r.ledger.put("run-2", measured(90), { verification: "failed" });
		expect(await observe(r, "run-2")).toEqual({
			status: "refused",
			reasonCode: "NOT_VERIFIED",
		});
		expect(count(life, "world_outcome")).toBe(0);
		expect(hostRows(life)).toHaveLength(0);
		expect(r.registered).toHaveLength(0);
		// The verified measurement says the opposite of the report: refuted.
		r.ledger.put("run-3", measured(110));
		expect((await observe(r, "run-3")).status).toBe("observed");
		expect(verdictOf(life, r).assessed).toMatchObject({ verdict: "refuted" });
		// Nothing outside the ledger namespace can be observed (a chat message is not a runtime result).
		expect(
			await r.observation.observe({
				scope: SCOPE,
				ledger: {
					namespace: "conversation",
					kind: "message",
					id: "m1",
					representation: "text",
				},
				prediction: REF,
			}),
		).toEqual({ status: "refused", reasonCode: "LEDGER_UNAVAILABLE" });
		// Another Scope's result looks like a missing one.
		r.ledger.put("run-4", measured(90), { scopeKey: "other-scope" });
		expect(await observe(r, "run-4")).toEqual({
			status: "refused",
			reasonCode: "LEDGER_UNAVAILABLE",
		});
	} finally {
		await life.cleanup();
	}
});

test("A18/A45 missing comparison conditions are incomparable: no Outcome is created, the missing fields are the reasons", async () => {
	const life = await ready();
	try {
		const r = rig(life);
		const cases: [string, Partial<Record<string, undefined>>][] = [
			["unit", { unit: undefined }],
			["baselineRef", { baselineRef: undefined }],
			["configuration", { configuration: undefined }],
			["window", { window: undefined }],
			["value", { value: undefined }],
		];
		for (const [field, over] of cases) {
			r.ledger.put(`run-${field}`, measured(90, over as never));
			const result = await observe(r, `run-${field}`);
			expect(result).toMatchObject({
				status: "incomparable",
				reasons: [`CONDITION_MISSING_${field}`],
			});
		}
		r.ledger.put("run-nan", measured(Number.NaN));
		expect(await observe(r, "run-nan")).toMatchObject({
			status: "incomparable",
			reasons: ["CONDITION_MISSING_value"],
		});
		expect(count(life, "world_outcome")).toBe(0);
		expect(r.registered).toHaveLength(0);
		expect(hostRows(life).every((row) => row.state === "incomparable")).toBe(
			true,
		);
		const out = verdictOf(life, r);
		expect(out.assessed).toMatchObject({
			verdict: "incomparable",
			counts: { supported: 0, refuted: 0, incomparable: 0 },
		});
		expect(out.incomparable).toHaveLength(6);
		expect(missingConditions({})).toHaveLength(10);
	} finally {
		await life.cleanup();
	}
});

test("A18 conditions that are present but different are incomparable with the exact reason (unit, statistic, input profile, window, comparison)", async () => {
	const life = await ready();
	try {
		const r = rig(life);
		const cases: [string, number, Record<string, unknown>, string][] = [
			["unit", 0.09, { unit: "s" }, "UNIT_MISMATCH"],
			["stat", 90, { statistic: "p95" }, "STATISTIC_MISMATCH"],
			["profile", 90, { inputProfile: "large" }, "INPUT_PROFILE_MISMATCH"],
			["config", 90, { configuration: "cfg-b" }, "CONFIGURATION_MISMATCH"],
			["baseline", 90, { baselineRef: "base-2" }, "BASELINE_MISMATCH"],
			[
				"window",
				90,
				{
					window: {
						startMs: BASE.window.startMs + 1,
						endMs: BASE.window.endMs,
					},
				},
				"WINDOW_MISMATCH",
			],
		];
		for (const [id, value, over, reason] of cases) {
			r.ledger.put(`run-${id}`, measured(value, over));
			expect((await observe(r, `run-${id}`)).status).toBe("observed");
			const out = verdictOf(life, r);
			expect(
				out.assessed.status === "assessed" &&
					out.assessed.incomparableReasons.some((x) => x.reason === reason),
			).toBe(true);
		}
		const out = verdictOf(life, r);
		expect(out.assessed).toMatchObject({
			verdict: "incomparable",
			counts: { supported: 0, refuted: 0, incomparable: 6 },
		});
		// Another comparison id is refused by World itself and recorded as a finding.
		r.ledger.put("run-cmp", measured(90, { comparisonId: "cmp-other" }));
		expect(await observe(r, "run-cmp")).toMatchObject({
			status: "incomparable",
			reasons: ["COMPARISON_ID_MISMATCH"],
		});
		expect(count(life, "world_outcome")).toBe(6);
	} finally {
		await life.cleanup();
	}
});

test("A45 a duplicate notice is idempotent: one Outcome, one trace row, one Memory dependent", async () => {
	const life = await ready();
	try {
		const r = rig(life);
		r.ledger.put("run-1", measured(90));
		const first = await observe(r, "run-1");
		expect(first.status).toBe("observed");
		for (let i = 0; i < 3; i++)
			expect(await observe(r, "run-1")).toMatchObject({
				status: "duplicate",
				state: "observed",
				outcome: { revision: 1 },
			});
		expect(count(life, "world_outcome")).toBe(1);
		expect(hostRows(life)).toHaveLength(1);
		expect(r.registered).toHaveLength(1);
		expect(count(life, "world_host_dependent")).toBe(1);
		expect(verdictOf(life, r).assessed).toMatchObject({
			counts: { supported: 1, refuted: 0, incomparable: 0 },
		});
		// A repeated incomparable notice is a duplicate too.
		r.ledger.put("run-2", measured(90, { unit: undefined }));
		await observe(r, "run-2");
		expect(await observe(r, "run-2")).toMatchObject({
			status: "duplicate",
			state: "incomparable",
		});
		expect(hostRows(life)).toHaveLength(2);
	} finally {
		await life.cleanup();
	}
});

test("A45 the Outcome stands on the ledger version in Memory: its dependent depends on the ledger source", async () => {
	const life = await ready();
	try {
		const seen: { externalId: string; dependsOn: unknown }[] = [];
		const r = rig(life, {
			register: (_db, input) => {
				seen.push(
					...input.dependents.map((d) => ({
						externalId: d.externalId,
						dependsOn: d.dependsOn,
					})),
				);
				return { dependents: 1, registered: 1, unchanged: 0 };
			},
		});
		r.ledger.put("run-1", measured(90));
		await observe(r, "run-1");
		expect(seen).toHaveLength(1);
		expect(seen[0]!.externalId.startsWith("w1o-")).toBe(true);
		expect(seen[0]!.dependsOn).toEqual([
			{
				type: "source",
				id: JSON.stringify([
					"runtime-ledger",
					"execution_result",
					"run-1",
					"measurement",
				]),
			},
		]);
	} finally {
		await life.cleanup();
	}
});

test("A45 a Memory refusal rolls the whole observation back: no Outcome, no trace", async () => {
	const life = await ready();
	try {
		const r = rig(life, {
			register: () => {
				throw new MemoryRegistrationRejected("rejected", "MEMORY_TOMBSTONED");
			},
		});
		r.ledger.put("run-1", measured(90));
		expect(await observe(r, "run-1")).toEqual({
			status: "rejected",
			reasonCode: "MEMORY_TOMBSTONED",
			stage: "memory",
		});
		expect(count(life, "world_outcome")).toBe(0);
		expect(hostRows(life)).toHaveLength(0);
		expect(count(life, "world_host_dependent")).toBe(0);
	} finally {
		await life.cleanup();
	}
});

test("A45 the real Memory registration: accepted for a live ledger source, refused (and rolled back) once Memory forgot that source", async () => {
	const life = await ready();
	try {
		const ledger = fixtureLedger();
		const real = createRuntimeObservation({
			store: life.store,
			world: life.world,
			ledger: ledger.port,
			purpose: ACCESS.purpose,
			clock: () => NOW,
		});
		const run = (id: string) =>
			real.observe({ scope: SCOPE, ledger: keyOf(id), prediction: REF });
		ledger.put("run-1", measured(90));
		expect((await run("run-1")).status).toBe("observed");
		expect(count(life, "world_outcome")).toBe(1);
		expect(count(life, "world_host_dependent")).toBe(1);
		// Memory forgets a ledger source: it takes no new dependent on it.
		await memoryForgetSource(life, sourceKeyOf(keyOf("run-2")));
		ledger.put("run-2", measured(90));
		expect(await run("run-2")).toEqual({
			status: "rejected",
			reasonCode: "MEMORY_TOMBSTONED",
			stage: "memory",
		});
		expect(count(life, "world_outcome")).toBe(1);
		expect(hostRows(life)).toHaveLength(1);
		expect(count(life, "world_host_dependent")).toBe(1);
	} finally {
		await life.cleanup();
	}
});

test("A45 a ledger correction supersedes: the next verified revision is the next Outcome revision, only it is judged", async () => {
	const life = await ready();
	try {
		const r = rig(life);
		r.ledger.put("run-1", measured(90));
		await observe(r, "run-1");
		expect(verdictOf(life, r).assessed).toMatchObject({ verdict: "supported" });
		// The owner corrects the result: it was really 110 ms.
		r.ledger.correct("run-1", { measurement: measured(110) });
		// Until reconciled the old version is no longer current: it is NOT judged.
		const before = verdictOf(life, r);
		expect(before.stale).toBe(1);
		expect(before.assessed).toMatchObject({
			verdict: "incomparable",
			counts: { supported: 0, refuted: 0, incomparable: 0 },
		});
		expect(await r.observation.reconcile(SCOPE)).toMatchObject({
			checked: 1,
			corrected: 1,
			withdrawn: 0,
		});
		const after = verdictOf(life, r);
		expect(after.stale).toBe(0);
		expect(after.assessed).toMatchObject({ verdict: "refuted" });
		expect(after.trace).toEqual([
			{
				outcome: { id: expect.any(String), revision: 2 },
				ledger: expect.objectContaining({ revision: "r2" }),
			},
		]);
		expect(hostRows(life).map((x) => [x.ledger_revision, x.state])).toEqual([
			["r1", "superseded"],
			["r2", "observed"],
		]);
		// A second sweep changes nothing.
		expect(await r.observation.reconcile(SCOPE)).toMatchObject({
			checked: 1,
			unchanged: 1,
			corrected: 0,
		});
	} finally {
		await life.cleanup();
	}
});

test("A45 a correction that removes verification withdraws the measurement from World", async () => {
	const life = await ready();
	try {
		const r = rig(life);
		r.ledger.put("run-1", measured(90));
		await observe(r, "run-1");
		expect(count(life, "world_outcome")).toBe(1);
		r.ledger.correct("run-1", { verification: "unverified" });
		const report = await r.observation.reconcile(SCOPE);
		expect(report).toMatchObject({ withdrawn: 1, pending: 0 });
		expect(count(life, "world_outcome")).toBe(0);
		expect(hostRows(life).map((x) => x.state)).toEqual(["withdrawn"]);
		expect(count(life, "world_host_dependent")).toBe(0);
		// Not judged, and a repeat notice is not an observation either.
		expect(await observe(r, "run-1")).toEqual({
			status: "refused",
			reasonCode: "NOT_VERIFIED",
		});
	} finally {
		await life.cleanup();
	}
});

test("A45 the ledger forgets the result: it is not judged, and the Outcome is erased by the forget procedure", async () => {
	const life = await ready();
	try {
		const r = rig(life);
		r.ledger.put("run-1", measured(90));
		await observe(r, "run-1");
		r.ledger.forget("run-1");
		const out = verdictOf(life, r);
		expect(out.stale).toBe(1);
		expect(out.trace).toHaveLength(0);
		const report = await r.observation.reconcile(SCOPE);
		expect(report).toMatchObject({ withdrawn: 1, pending: 0 });
		expect(count(life, "world_outcome")).toBe(0);
		expect(hostRows(life).map((x) => x.state)).toEqual(["withdrawn"]);
		const forgets = life.store.read((db) =>
			db
				.query(
					"SELECT reason_code, origin, roots_json FROM world_host_forget_intake",
				)
				.all(),
		) as { reason_code: string; origin: string; roots_json: string }[];
		expect(forgets).toHaveLength(1);
		expect(forgets[0]).toMatchObject({ reason_code: "SOURCE_FORGOTTEN" });
		expect(JSON.parse(forgets[0]!.roots_json)).toEqual([
			{ kind: "outcome", id: expect.any(String), revision: 1 },
		]);
		// Idempotent: nothing observed is left to sweep.
		expect(await r.observation.reconcile(SCOPE)).toMatchObject({ checked: 0 });
	} finally {
		await life.cleanup();
	}
});

test("A45 Memory forgets the ledger source: World's forget reaches the Outcome (not only assertions), the trace goes with it, the external deletion is confirmed truthfully", async () => {
	const life = await ready();
	try {
		const ledger = fixtureLedger();
		const real = createRuntimeObservation({
			store: life.store,
			world: life.world,
			ledger: ledger.port,
			purpose: ACCESS.purpose,
			clock: () => NOW,
		});
		ledger.put("run-1", measured(90));
		ledger.put("run-2", measured(110));
		for (const id of ["run-1", "run-2"])
			expect(
				(
					await real.observe({
						scope: SCOPE,
						ledger: keyOf(id),
						prediction: REF,
					})
				).status,
			).toBe("observed");
		expect(count(life, "world_outcome")).toBe(2);
		const forget = await memoryForgetSource(life, sourceKeyOf(keyOf("run-1")));
		const consumed = await life.lifecycle.consumeMemoryChanges(SCOPE);
		expect(consumed.forgets[0]).toMatchObject({ complete: true });
		// Only the forgotten result's Outcome is gone; the other still stands.
		expect(count(life, "world_outcome")).toBe(1);
		expect(hostRows(life).map((x) => x.state)).toEqual(["observed"]);
		expect(
			worldExternals(life, forget.forgetId).every(
				(e) => e.state === "confirmed",
			),
		).toBe(true);
		const out = real.assess({ scope: SCOPE, prediction: PREDICTION });
		if ("status" in out) throw new Error(out.reasonCode);
		expect(out.assessed).toMatchObject({
			verdict: "refuted",
			counts: { supported: 0, refuted: 1, incomparable: 0 },
		});
	} finally {
		await life.cleanup();
	}
});

test("A45 World OFF or a closed gate observes nothing; a missing prediction is refused without a trace", async () => {
	const life = await ready();
	try {
		const r = rig(life);
		r.ledger.put("run-1", measured(90));
		await life.world.setEnabled(false);
		expect(await observe(r, "run-1")).toMatchObject({
			status: "blocked",
			reasonCode: "WORLD_DISABLED",
		});
		await life.world.setEnabled(true);
		life.gate.close("TEST");
		expect(await observe(r, "run-1")).toMatchObject({
			status: "blocked",
			reasonCode: "WORLD_RECOVERY_REQUIRED",
		});
		life.gate.open();
		expect(
			await observe(r, "run-1", { predictionId: "no-such", revision: 1 }),
		).toMatchObject({ status: "rejected", reasonCode: "PREDICTION_NOT_FOUND" });
		expect(hostRows(life)).toHaveLength(0);
		expect(count(life, "world_outcome")).toBe(0);
		expect(r.registered).toHaveLength(0);
	} finally {
		await life.cleanup();
	}
});

test("A18 a qualitative claim has no measurement plan: it is a measurement gap, an observation of it is incomparable", async () => {
	const life = await ready();
	try {
		const qualitative: Prediction = {
			kind: "qualitative",
			predictionId: "pred-q",
			revision: 1,
			relation: "causes",
			subjectId: "svc-1",
			objectId: "svc-2",
		};
		expect(
			(
				await life.world.apply({
					access: ACCESS,
					scope: SCOPE,
					operationKey: "pred-q",
					clock: NOW,
					operation: {
						kind: "prediction.register",
						input: { prediction: qualitative, dueAt: NOW + 1000 },
					} as never,
				})
			).status,
		).toBe("applied");
		const r = rig(life);
		r.ledger.put("run-1", measured(90));
		expect(
			await observe(r, "run-1", { predictionId: "pred-q", revision: 1 }),
		).toMatchObject({
			status: "incomparable",
			reasons: ["COMPARISON_ID_MISMATCH"],
		});
		const out = r.observation.assess({ scope: SCOPE, prediction: qualitative });
		if ("status" in out) throw new Error(out.reasonCode);
		expect(out.assessed).toMatchObject({ status: "measurement_gap" });
	} finally {
		await life.cleanup();
	}
});
