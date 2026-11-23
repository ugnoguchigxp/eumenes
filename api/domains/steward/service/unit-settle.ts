import { getLogger } from "../../../infrastructure/logger";
import type { StewardJobHandler, StewardPayload } from "../contracts";
import { closeUnit, readUnit, takeRequests, type UnitRow } from "../repository";
import { forgetClosure } from "./forget-closure";
import type { Kick } from "./kick";
import { noticeInTransaction } from "./notices";
import type { UnitEnd } from "./unit-end";
import type {
	ApplyResult,
	LlmInput,
	LlmOutput,
	ClosureInput,
	ClosureOutput,
	StepEnv,
	StewardDeps,
	StewardInput,
	StewardOutput,
} from "./types";

const log = getLogger("steward");

type Settle = Parameters<
	StewardJobHandler<
		StewardPayload,
		StewardInput,
		StewardOutput
	>["settleInTransaction"]
>;

/** Settle: re-checks the fences (section 6.5), then adopts the answer or drops it; every ending releases the request. */
export function createSettle(deps: StewardDeps, kick: Kick, end: UnitEnd) {
	const { inference, memory } = deps;

	function adopt(
		env: StepEnv,
		input: LlmInput,
		unit: UnitRow,
		result: LlmOutput,
		jobId: string,
	): "applied" {
		const { db } = env;
		const { conversationId } = unit;
		db.exec("SAVEPOINT steward_apply");
		let applied: ApplyResult;
		try {
			applied = input.step.apply(
				env,
				input.prepared,
				result.output,
				result.extras,
			);
		} catch (error) {
			db.exec("ROLLBACK TO steward_apply");
			db.exec("RELEASE steward_apply");
			log.warn(
				"steward.apply_failed",
				{ stepId: unit.step, reason: "apply_failed" },
				error,
			);
			end.failUnit(env, unit, jobId, "apply_failed", true, {
				durationMs: result.durationMs,
			});
			return "applied";
		}
		if (applied.stale !== undefined || applied.unusable === true) {
			db.exec("ROLLBACK TO steward_apply");
			db.exec("RELEASE steward_apply");
			if (applied.stale !== undefined)
				end.staleUnit(env, unit, jobId, applied.stale);
			else
				end.failUnit(env, unit, jobId, "invalid_output", true, {
					durationMs: result.durationMs,
					outputTokens: result.outputTokens,
				});
			return "applied";
		}
		db.exec("RELEASE steward_apply");
		// A World unit changes nothing the Window carries (the answer's World context is read per answer).
		const publishes = unit.slot !== "world";
		const before = publishes
			? (memory.windows.storedInTransaction(db, conversationId)?.version ??
				null)
			: null;
		const snapshot = publishes
			? memory.publishWindowInTransaction(
					db,
					conversationId,
					applied.requestRepublish ? { requestRepublish: true } : {},
				)
			: null;
		applied.notices.forEach((text, i) =>
			noticeInTransaction(deps, db, conversationId, text, `${unit.id}:${i}`),
		);
		end.record(
			env,
			unit,
			{
				jobId,
				output: applied.output,
				results: applied.results,
				durationMs: result.durationMs,
				outputTokens: result.outputTokens,
				after: snapshot?.version ?? null,
				refs: applied.refs,
			},
			before,
		);
		closeUnit(db, unit.id, "applied", deps.clock());
		log.info("steward.unit_settled", {
			stepId: unit.step,
			kind: unit.kind,
			applied: applied.applied,
			rejected: applied.rejected,
			durationMs: result.durationMs,
			jobId,
		});
		kick.kickOne(db, conversationId);
		return "applied";
	}

	/**
	 * The closure delete's settle: the forget is carried out inside this transaction. A failure inside it ends the unit
	 * as failed, rolled back.
	 */
	function settleClosureInTransaction(
		db: Settle[0],
		claim: Settle[1],
		input: StewardInput | null,
		outcome: Settle[3],
		unit: UnitRow,
	) {
		const env: StepEnv = { db, deps, conversationId: unit.conversationId };
		// A retry runs the same unit again.
		if (outcome.type === "retry") return "applied" as const;
		if (outcome.type !== "success" || input?.kind !== "closure") {
			const code =
				outcome.type === "failed" || outcome.type === "interrupted"
					? outcome.errorCode
					: outcome.type === "expired"
						? "deadline_exceeded"
						: "no_input";
			end.failUnit(env, unit, claim.jobId, code, outcome.type === "failed");
			return "applied" as const;
		}
		const result = outcome.result;
		if (result.kind !== "closure") return "applied" as const;
		return adoptClosure(env, input, unit, result, claim.jobId);
	}

	function adoptClosure(
		env: StepEnv,
		input: ClosureInput,
		unit: UnitRow,
		result: ClosureOutput,
		jobId: string,
	): "applied" {
		const { db } = env;
		db.exec("SAVEPOINT steward_closure");
		let settled: ReturnType<typeof forgetClosure.settle>;
		try {
			settled = forgetClosure.settle(env, input);
		} catch (error) {
			db.exec("ROLLBACK TO steward_closure");
			db.exec("RELEASE steward_closure");
			log.warn(
				"steward.apply_failed",
				{ stepId: unit.step, reason: "apply_failed" },
				error,
			);
			end.failUnit(env, unit, jobId, "apply_failed", true, {
				durationMs: result.durationMs,
			});
			return "applied";
		}
		db.exec("RELEASE steward_closure");
		if (settled.failed) {
			end.failUnit(
				env,
				unit,
				jobId,
				settled.failed.code,
				settled.failed.count,
				{ durationMs: result.durationMs },
			);
			return "applied";
		}
		end.record(
			env,
			unit,
			{
				jobId,
				results: settled.results,
				durationMs: result.durationMs,
				refs: settled.refs,
			},
			null,
		);
		closeUnit(db, unit.id, "applied", deps.clock());
		log.info("steward.unit_settled", {
			stepId: unit.step,
			kind: unit.kind,
			durationMs: result.durationMs,
			jobId,
		});
		// What came while this unit ran is looked at now.
		kick.kickOne(db, unit.conversationId);
		return "applied";
	}

	function settleInTransaction(...[db, claim, input, outcome]: Settle) {
		const held = takeRequests(db, claim.jobId);
		const unit = readUnit(db, claim.payload.unitId);
		if (!unit || unit.state !== "open") {
			end.release(db, held);
			return "applied" as const;
		}
		if (unit.step === "forget-closure")
			return settleClosureInTransaction(db, claim, input, outcome, unit);
		const env: StepEnv = { db, deps, conversationId: unit.conversationId };
		// A retry runs the same unit again: its next prepare takes a new request.
		if (outcome.type === "retry") {
			end.release(db, held);
			end.releaseWorld(db, unit);
			return "applied" as const;
		}
		if (outcome.type !== "success" || input?.kind !== "llm") {
			end.release(db, held);
			const code =
				outcome.type === "failed" || outcome.type === "interrupted"
					? outcome.errorCode
					: outcome.type === "expired"
						? "deadline_exceeded"
						: "no_input";
			// Only a real inference failure counts against the targets: a missed deadline (the queue was busy), a
			// restart and the conversation taking its connection are not their fault, and a new unit follows.
			end.failUnit(
				env,
				unit,
				claim.jobId,
				code,
				outcome.type === "failed" && code !== "larm_preempted",
			);
			return "applied" as const;
		}
		const result = outcome.result;
		if (result.kind !== "llm") {
			end.release(db, held);
			return "applied" as const;
		}
		if (!memory.readyInTransaction(db)) {
			end.release(db, held);
			end.releaseWorld(db, unit);
			closeUnit(db, unit.id, "stale", deps.clock());
			log.info("steward.unit_stale", {
				stepId: unit.step,
				reason: "memory_unavailable",
				jobId: claim.jobId,
			});
			return "applied" as const;
		}
		// Section 6.5: a forget since prepare means this answer stood on stale ground.
		const fenced =
			unit.forgetSeq !== null &&
			unit.forgetSeq !== memory.forgetSeqInTransaction(db)
				? "stale_forget"
				: result.receipt.requestId !== input.requestId
					? "receipt_mismatch"
					: null;
		if (fenced) {
			end.release(db, held);
			end.staleUnit(env, unit, claim.jobId, fenced);
			return "applied" as const;
		}
		if (result.output === null) {
			inference.rejectControlInTransaction(
				db,
				result.receipt,
				"steward_invalid_output",
			);
			end.failUnit(env, unit, claim.jobId, "invalid_output", true, {
				durationMs: result.durationMs,
				outputTokens: result.outputTokens,
			});
			return "applied" as const;
		}
		if (!inference.acceptInTransaction(db, result.receipt)) {
			end.release(db, held);
			end.failUnit(env, unit, claim.jobId, "not_accepted", true, {
				durationMs: result.durationMs,
			});
			return "applied" as const;
		}
		return adopt(env, input, unit, result, claim.jobId);
	}

	return settleInTransaction;
}
