import {
	createPursuitEngine,
	policySchema,
	type PursuitRuntime,
	type PursuitStore,
} from "eumenes-pursuit";
import { findPursuitByOperation, loadPursuit } from "eumenes-pursuit/sqlite";
import policy from "./policy.json";
import { current, type Context } from "./context";
import { stateOf } from "../repository";
import { model } from "./model";
import { acceptance, criteria } from "./acceptance";
import { researchTools } from "./tools";

export const operationKey = (id: string, epoch: number) =>
	`pursuit:${id}:${epoch}`;
export function core(ctx: Context, id: string, epoch: number) {
	const store: PursuitStore = {
		write: (op) =>
			ctx.store.write((db) => {
				current(ctx, db, id, epoch);
				return op(db);
			}),
		readSnapshot: async (op) =>
			ctx.store.readSnapshot((db) => {
				current(ctx, db, id, epoch);
				return op(db);
			}),
	};
	const llm = model(ctx, id, epoch);
	const runtime: PursuitRuntime = {
		...researchTools(ctx, id, epoch),
		acceptance: acceptance(ctx, id, epoch, llm),
	};
	const engine = createPursuitEngine({
		store,
		clock: { now: ctx.now },
		ids: { next: () => ctx.id() },
		generator: llm,
		reviewer: llm,
		judge: null,
	});
	const startInput = ctx.store.readSnapshot((db) => {
		const row = current(ctx, db, id, epoch),
			state = stateOf(row);
		// Restart with the accepted input, including the crash window before core_id was saved.
		const existingId =
			row.core_id ?? findPursuitByOperation(db, operationKey(id, epoch));
		if (existingId) {
			const existing = loadPursuit(db, existingId);
			if (!existing) throw new Error("pursuit_core_missing");
			return existing.input;
		}
		return {
			goal: state.request,
			acceptance: criteria,
			grant: ["research"],
			goalRef: null,
			label: id,
			policy: policySchema.parse({
				...policy,
				budget: {
					...policy.budget,
					wallMs: row.deadline - row.created_at,
					attempts: state.limits.childCalls * 3,
				},
			}),
			conditions: {
				rules: true,
				judge: false,
				review: true,
				questionSet: { id: "pursuit-guards", version: 1 },
				adapter: null,
				language: "ja",
				findings: "all",
				strategyChange: "distinct",
				selfCheck: "parts",
				verifyOn: "claim",
				prediction: "falsifiable",
				completionCheck: "acceptance",
				rollback: "keep",
				verdictLabel: "refutation",
				claimFeedback: "verdict",
				attemptCount: "all",
			},
		};
	});
	return { engine, runtime, startInput };
}
