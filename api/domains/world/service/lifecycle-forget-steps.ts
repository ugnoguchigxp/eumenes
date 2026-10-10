import {
	advanceIntake,
	getIntake,
	setBlockedReason,
	setWorldProgress,
	type ForgetRoot,
	type IntakeRow,
} from "../repository/lifecycle";
import { recordAbandoned } from "../repository/guard";
import { appendWorldJournal } from "./world-journal";
import type { ForgetReport } from "./lifecycle-types";
import {
	MAX_CHUNK_ROOTS,
	StepBlocked,
	splitValidRoots,
	why,
	scopeOf,
	forgetKey,
	partId,
	partCount,
} from "./lifecycle-shared";
import type { LifecycleCtx } from "./lifecycle-lock";

export function createWorldSteps(ctx: LifecycleCtx) {
	const { options, store, world, now, maxChunks, hook, worldOp } = ctx;

	// --- step 2: World journal (fsync) -------------------------------------------

	async function journalStep(intake: IntakeRow): Promise<void> {
		await store.write((db) => {
			const row = getIntake(db, intake.forgetId);
			if (!row || row.state !== "pending") return;
			// Idempotent per forgetId: a crash after the append repeats this safely.
			const entry = appendWorldJournal(options.journalPath, {
				forgetId: row.forgetId,
				memoryForgetId: row.memoryForgetId,
				principal: row.principal,
				scopeKey: row.scopeKey,
				reasonCode: row.reasonCode,
				roots: row.roots,
			});
			hook("journal_appended", row.forgetId);
			advanceIntake(db, row.forgetId, "pending", "journaled", now(), {
				journalSeq: entry.seq,
				journalHash: entry.hash,
			});
		});
		hook("journaled", intake.forgetId);
	}

	async function worldStep(intake: IntakeRow): Promise<{
		progress: ForgetReport["world"];
		blocked: string | null;
	}> {
		let last: ForgetReport["world"] = null;
		let blocked: string | null = null;
		for (;;) {
			const out = await store.write((db) => {
				const row = getIntake(db, intake.forgetId);
				if (!row || row.state !== "journaled")
					return { done: true as const, blocked: null, progress: null };
				const scope = scopeOf(row);
				const parts = partCount(row);
				let part = row.worldPart;
				let chunks = row.worldChunks;
				let progress: ForgetReport["world"] = null;
				for (let applied = 0; applied < maxChunks && part < parts; applied++) {
					const id = partId(row.forgetId, part);
					let roots: ForgetRoot[] = [];
					if (chunks === 0) {
						// Roots World would refuse as ids are skipped (and said so), never
						// allowed to block the valid ones of the same part.
						const given = row.roots.slice(
							part * MAX_CHUNK_ROOTS,
							(part + 1) * MAX_CHUNK_ROOTS,
						);
						const split = splitValidRoots(given);
						roots = split.valid;
						if (roots.length === 0) {
							// Nothing in this part can name stored data: no World forget exists.
							recordAbandoned(
								db,
								{
									forgetId: row.forgetId,
									part,
									skippedRoots: given.length,
									wholePart: true,
									reason: "NO_VALID_ROOTS",
								},
								now(),
							);
							part += 1;
							chunks = 0;
							setWorldProgress(db, row.forgetId, part, chunks, now());
							hook("world_part_abandoned", row.forgetId);
							continue;
						}
						if (split.rejected > 0)
							recordAbandoned(
								db,
								{
									forgetId: row.forgetId,
									part,
									skippedRoots: split.rejected,
									wholePart: false,
									reason: "INVALID_ROOT_ID",
								},
								now(),
							);
					}
					const result = worldOp(
						db,
						scope,
						forgetKey(id, chunks === 0 ? "rc" : "dr", chunks),
						{
							kind: "forget.chunk",
							forgetId: id,
							reasonCode: row.reasonCode,
							roots,
						},
					);
					if (
						chunks === 0 &&
						result.status === "rejected" &&
						(result.reasonCode === "INVALID_INPUT" ||
							result.reasonCode === "LIMIT_EXCEEDED")
					) {
						// World refuses this part for good and wrote nothing (its checks run
						// before the first write). An explicit durable terminal, reported and
						// never counted as complete, instead of a gate that never opens.
						recordAbandoned(
							db,
							{
								forgetId: row.forgetId,
								part,
								skippedRoots: roots.length,
								wholePart: true,
								reason: `WORLD_${result.reasonCode}`,
							},
							now(),
						);
						part += 1;
						chunks = 0;
						setWorldProgress(db, row.forgetId, part, chunks, now());
						hook("world_part_abandoned", row.forgetId);
						continue;
					}
					if (result.status !== "applied" && result.status !== "no_op") {
						// A part that is already complete is never an excuse to skip
						// roots: parts only get roots in their first op, so this is a refusal.
						const reason = `WORLD_${why(result)}`;
						setBlockedReason(db, row.forgetId, reason, now());
						return { done: false as const, blocked: reason, progress };
					}
					chunks += 1;
					setWorldProgress(db, row.forgetId, part, chunks, now());
					hook("world_chunk", row.forgetId);
					const forget = result.forget;
					if (forget === undefined)
						throw new StepBlocked("WORLD_PROGRESS_MISSING");
					progress = {
						state: forget.state,
						processed: forget.processed,
						pending: forget.pending,
					};
					if (forget.state !== "complete") continue;
					// Verified: a further chunk of a complete forget is refused as such.
					const verify = worldOp(db, scope, forgetKey(id, "vf", chunks), {
						kind: "forget.chunk",
						forgetId: id,
						reasonCode: row.reasonCode,
						roots: [],
					});
					if (
						!(
							verify.status === "rejected" &&
							verify.reasonCode === "FORGET_ALREADY_COMPLETE"
						)
					)
						throw new StepBlocked("WORLD_NOT_VERIFIED");
					part += 1;
					chunks = 0;
					setWorldProgress(db, row.forgetId, part, chunks, now());
				}
				if (part < parts)
					return { done: false as const, blocked: null, progress };
				advanceIntake(db, row.forgetId, "journaled", "world_applied", now());
				// The World content is gone: any answer still in flight is stale.
				world.bumpForgetEpochInWriter(db, scope);
				return { done: true as const, blocked: null, progress };
			});
			if (out.progress) last = out.progress;
			if (out.blocked !== null) {
				blocked = out.blocked;
				break;
			}
			hook("world_call_done", intake.forgetId);
			if (out.done) break;
		}
		return { progress: last, blocked };
	}

	return { journalStep, worldStep };
}
