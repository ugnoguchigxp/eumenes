import { expect, test } from "bun:test";
import { createPursuitEngine, policySchema } from "eumenes-pursuit";
import { loadPursuit } from "eumenes-pursuit/sqlite";
import { waitFor } from "../../../infrastructure/wait-for";
import { rowOf, stateOf } from "../repository";
import { criteria } from "../service/acceptance";
import policy from "../service/policy.json";
import { fixture } from "./pursuit.fixture";

test("recovery reuses an orphan core's frozen input after host defaults change", async () => {
	const f = await fixture();
	try {
		const row = f.store().read((db) => rowOf(db, f.id)!);
		const state = stateOf(row);
		const unavailable = {
			complete: async () => {
				throw new Error("start_must_not_infer");
			},
		};
		const previous = createPursuitEngine({
			store: {
				write: (fn) => f.store().write(fn),
				readSnapshot: async (fn) => f.store().readSnapshot(fn),
			},
			clock: { now: () => row.created_at },
			ids: { next: () => crypto.randomUUID() },
			generator: unavailable,
			reviewer: unavailable,
			judge: null,
		});
		const started = await previous.start(
			{
				goal: state.request,
				acceptance: criteria,
				grant: ["research"],
				goalRef: null,
				label: f.id,
				policy: policySchema.parse({
					...policy,
					budget: {
						...policy.budget,
						wallMs: row.deadline - row.created_at,
						attempts: state.limits.childCalls * 3,
						transitions: 100,
					},
				}),
				conditions: {
					rules: true,
					judge: false,
					review: true,
					questionSet: { id: "pursuit-guards", version: 1 },
					adapter: null,
					language: "ja",
					findings: "verified",
					strategyChange: "distinct",
					selfCheck: "parts",
					verifyOn: "claim",
					prediction: "falsifiable",
					completionCheck: "acceptance",
					rollback: "keep",
					verdictLabel: "refutation",
					claimFeedback: "verdict",
					attemptCount: "mutating",
				},
			},
			`pursuit:${f.id}:0`,
		);
		// Crash between core acceptance and saving the host correspondence.
		expect(f.store().read((db) => rowOf(db, f.id)!.core_id)).toBeNull();
		f.start();
		await waitFor(() =>
			["waiting_child", "failed"].includes(f.view()?.status ?? ""),
		);
		expect(f.view()?.status).toBe("waiting_child");
		expect(f.store().read((db) => rowOf(db, f.id)!.core_id)).toBe(
			started.pursuitId,
		);
		await f.finishWeb();
		await waitFor(
			() => f.observations.size === 2 && f.view()?.status === "waiting_child",
		);
		await f.finishWeb();
		await waitFor(() => f.view()?.status === "completed");
		const frozen = f
			.store()
			.readSnapshot((db) => loadPursuit(db, started.pursuitId)!)!;
		expect(frozen.input.conditions.findings).toBe("verified");
		expect(frozen.input.conditions.attemptCount).toBe("mutating");
		expect(frozen.input.policy.budget.transitions).toBe(100);
	} finally {
		await f.close();
	}
}, 15000);
