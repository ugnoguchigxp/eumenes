import type { Database } from "bun:sqlite";
import {
	CAPTURE_RETRY_MS,
	FOREGROUND_DELAYS_MS,
	INFERENCE_MS,
	MAX_OUTPUT_TOKENS,
	type StewardPayload,
} from "../contracts";
import {
	type UnitRow,
	closeUnit,
	putRequest,
	readState,
	readUnit,
	setUnitPrepared,
	writeState,
} from "../repository";
import type { Kick } from "./kick";
import { buildMessages } from "./messages";
import { steps } from "./steps";
import type { UnitEnd } from "./unit-end";
import type { PreparedUnit, StepEnv, StewardDeps, StewardInput } from "./types";
import type { Wake } from "./wake";

/** Prepare: fences the unit (memory ready, upkeep not behind a foreground run), builds the input and takes the request. */
export function createPrepare(
	deps: StewardDeps,
	kick: Kick,
	end: UnitEnd,
	wake: Wake,
) {
	const { inference, memory } = deps;

	function capture(
		db: Database,
		claim: { jobId: string; generation: number; attempt: number },
		step: UnitRow["step"],
	) {
		const worldResourceId =
			step === "curate-world" ? (deps.worldResourceId?.() ?? null) : null;
		db.exec("SAVEPOINT steward_capture");
		try {
			const deadline = deps.nowMs() + INFERENCE_MS;
			const requestId = inference.captureBackgroundControlInTransaction(db, {
				taskId: "steward",
				// One request per attempt of the job: a retry binds a new deadline.
				decisionId: `${claim.jobId}.${claim.attempt}`,
				authorityEpoch: 1,
				executionGeneration: claim.generation,
				deadline,
				taskDeadline: deadline,
				maxOutputTokens: MAX_OUTPUT_TOKENS,
				// The conversation's own route (cloud allowed), or the resource chosen for World; the schema as a strict one.
				route: worldResourceId
					? { resourceId: worldResourceId }
					: "conversation",
				structuredOutput: true,
			});
			db.exec("RELEASE steward_capture");
			return requestId;
		} catch {
			db.exec("ROLLBACK TO steward_capture");
			db.exec("RELEASE steward_capture");
			return null;
		}
	}

	/** Upkeep waits while an answer is being generated (30 s, 2 min, 10 min); the unit is made again for later. */
	function deferForForeground(env: StepEnv, unit: UnitRow) {
		const { db } = env;
		const state = readState(db, unit.conversationId);
		const delay =
			FOREGROUND_DELAYS_MS[
				Math.min(state.deferCount, FOREGROUND_DELAYS_MS.length - 1)
			]!;
		const round = state.quiet.round;
		const nextMaintenanceAt = deps.nowMs() + delay;
		writeState(db, {
			...state,
			deferCount: state.deferCount + 1,
			nextMaintenanceAt,
			quiet: round
				? {
						...state.quiet,
						round: { ...round, count: Math.max(0, round.count - 1) },
					}
				: state.quiet,
		});
		closeUnit(db, unit.id, "stale", deps.clock());
		// Nothing is enqueued for later: the timer kicks again when the wait is over.
		wake.at(nextMaintenanceAt);
		kick.kickOne(db, unit.conversationId);
	}

	function prepareInTransaction(
		db: Database,
		claim: {
			jobId: string;
			generation: number;
			attempt: number;
			payload: StewardPayload;
		},
	):
		| { status: "ready"; input: StewardInput }
		| { status: "stale"; reason: string } {
		const unit = readUnit(db, claim.payload.unitId);
		if (!unit || unit.state !== "open")
			return { status: "stale", reason: "unit_closed" };
		const env: StepEnv = { db, deps, conversationId: unit.conversationId };
		const step = steps[unit.step];
		const close = (reason: string) => {
			// A World unit that got as far as prepare has registered what its model would see: given back.
			end.releaseWorld(db, unit);
			closeUnit(db, unit.id, "stale", deps.clock());
			return { status: "stale" as const, reason };
		};
		if (!memory.readyInTransaction(db)) return close("memory_unavailable");
		if (
			unit.slot === "maintenance" &&
			!unit.targets.urgent &&
			deps.foregroundActive(db, unit.conversationId)
		) {
			deferForForeground(env, unit);
			return { status: "stale", reason: "foreground_active" };
		}
		const prepared = step.prepare(env, unit);
		if (prepared.status === "stale") {
			closeUnit(db, unit.id, "stale", deps.clock());
			if (unit.slot === "maintenance") end.markQuiet(db, unit);
			if (prepared.retryLater) {
				// Nothing can be done now (World can not be used, Memory refused): the timer makes the unit again.
				wake.pause(
					unit.conversationId,
					unit.slot,
					deps.nowMs() + CAPTURE_RETRY_MS,
				);
				return prepared;
			}
			// What made the unit empty changed the ledger: the next unit (or the end of the round) follows from it.
			kick.kickOne(db, unit.conversationId);
			return prepared;
		}
		const requestId = capture(db, claim, unit.step);
		if (requestId === null) {
			// Not the targets' fault and not counted; but it is not left until the next run: the timer tries again.
			wake.captureFailed(unit.conversationId, unit.slot);
			return close("background_inference_unavailable");
		}
		wake.captureSucceeded(unit.conversationId, unit.slot);
		// Kept in the database: a job lost to a restart or an expired lease can still release its request.
		putRequest(db, claim.jobId, unit.step, requestId);
		setUnitPrepared(db, unit.id, {
			forgetSeq: memory.forgetSeqInTransaction(db),
			// What the step reports replaces its own keys; an upkeep unit keeps its revision and urgency.
			targets: { ...unit.targets, ...prepared.targets },
		});
		if (unit.slot === "maintenance") {
			const state = readState(db, unit.conversationId);
			writeState(db, { ...state, deferCount: 0, nextMaintenanceAt: null });
		}
		const current = readUnit(db, unit.id)!;
		const preparedUnit: PreparedUnit = {
			unit: current,
			step: unit.step,
			data: prepared.data,
			context: prepared.context,
			targets: prepared.targets,
		};
		return {
			status: "ready",
			input: {
				unitId: unit.id,
				jobId: claim.jobId,
				conversationId: unit.conversationId,
				step,
				requestId,
				prepared: preparedUnit,
				messages: buildMessages(step, preparedUnit, prepared.data),
				startedAt: deps.nowMs(),
			},
		};
	}

	return prepareInTransaction;
}
