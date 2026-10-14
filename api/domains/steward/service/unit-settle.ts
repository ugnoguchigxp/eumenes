import { getLogger } from "../../../infrastructure/logger";
import type { StewardJobHandler, StewardPayload } from "../contracts";
import { closeUnit, readUnit, takeRequests, type UnitRow } from "../repository";
import type { Kick } from "./kick";
import type { UnitEnd } from "./unit-end";
import type {
	ApplyResult,
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
		input: StewardInput,
		unit: UnitRow,
		result: StewardOutput,
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
		const before =
			memory.windows.storedInTransaction(db, conversationId)?.version ?? null;
		const snapshot = memory.publishWindowInTransaction(db, conversationId, {
			...(applied.republishLongTerm ? { republishLongTerm: true } : {}),
			...(applied.prefetch ? { prefetch: applied.prefetch } : {}),
			...(applied.notices.length > 0 ? { addNotices: applied.notices } : {}),
		});
		end.record(
			env,
			unit,
			{
				jobId,
				output: applied.output,
				results: applied.results,
				durationMs: result.durationMs,
				outputTokens: result.outputTokens,
				after: snapshot.version,
				refs: applied.refs,
			},
			before,
		);
		end.settleState(env, unit, applied);
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

	function settleInTransaction(...[db, claim, input, outcome]: Settle) {
		const held = takeRequests(db, claim.jobId);
		const unit = readUnit(db, claim.payload.unitId);
		if (!unit || unit.state !== "open") {
			end.release(db, held);
			return "applied" as const;
		}
		const env: StepEnv = { db, deps, conversationId: unit.conversationId };
		// A retry runs the same unit again: its next prepare takes a new request.
		if (outcome.type === "retry") {
			end.release(db, held);
			return "applied" as const;
		}
		if (outcome.type !== "success" || !input) {
			end.release(db, held);
			const code =
				outcome.type === "failed" || outcome.type === "interrupted"
					? outcome.errorCode
					: outcome.type === "expired"
						? "deadline_exceeded"
						: "no_input";
			// Only a real inference failure counts against the targets: a missed deadline (the queue was busy) and a
			// restart are not their fault, and a new unit follows at once.
			end.failUnit(env, unit, claim.jobId, code, outcome.type === "failed");
			return "applied" as const;
		}
		const result = outcome.result;
		if (!memory.readyInTransaction(db)) {
			end.release(db, held);
			closeUnit(db, unit.id, "stale", deps.clock());
			log.info("steward.unit_stale", {
				stepId: unit.step,
				reason: "memory_unavailable",
				jobId: claim.jobId,
			});
			return "applied" as const;
		}
		// Section 6.5: a forget or a newer summary since prepare means this answer stood on stale ground.
		const fenced =
			unit.forgetSeq !== null &&
			unit.forgetSeq !== memory.forgetSeqInTransaction(db)
				? "stale_forget"
				: unit.summaryRevision !== null &&
					  unit.summaryRevision !==
							memory.summaryRevisionInTransaction(db, unit.conversationId)
					? "stale_summary"
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
