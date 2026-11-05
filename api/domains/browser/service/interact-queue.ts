import { z } from "zod";
import type { Database } from "bun:sqlite";
import {
	getRun,
	isTerminalRunStatus,
	transitionRun,
} from "eumenes-interact/sqlite";
import { interactMeta } from "../repository/interact";
import type { InteractMeta } from "../contracts/interact";
import { interactIso } from "./interact-authority";
import type { InteractState } from "./interact-state";
import type { InteractStepInput, InteractStepResult } from "./interact-step";
const JOB = "browser.interact.step";
export const INTERACT_EXPIRY_JOB = "browser.interact.expire";
const EXPIRY = INTERACT_EXPIRY_JOB;
const payload = z.strictObject({
	runId: z.uuid(),
	generation: z.number().int().min(0),
});
export function registerInteractQueue(state: InteractState) {
	const { deps, queue, now, memory, authority, step, question, scheduleFlush } =
		state;
	function enqueue(db: Database, meta: InteractMeta) {
		const { job } = queue.enqueueInTransaction(db, {
			scope: `browser-interact:${meta.owner}`,
			kind: JOB,
			payload: { runId: meta.run_id, generation: meta.generation },
			dedupeKey: `${meta.run_id}:${meta.generation}:${meta.calls}:${meta.revision}`,
			subjectRef: meta.run_id,
			lane: "interactive",
			concurrencyKey: `browser-interact:${meta.run_id}`,
			deadlineAtMs: Date.parse(
				getRun(db, meta.owner, meta.run_id)!.deadlineAt!,
			),
			maxAttempts: 1,
		});
		db.query("UPDATE browser_interact_runs SET job_id=? WHERE run_id=?").run(
			job.id,
			meta.run_id,
		);
	}
	queue.registerHandler<
		{ runId: string; generation: number },
		InteractStepInput,
		InteractStepResult
	>({
		kind: JOB,
		payloadVersions: [1],
		schema: payload,
		recovery: "interrupt",
		prepareInTransaction(db, claim) {
			const meta = interactMeta(db, claim.payload.runId);
			if (
				!meta ||
				meta.job_id !== claim.jobId ||
				meta.generation !== claim.payload.generation
			)
				return { status: "stale", reason: "browser_interact_stale" };
			const run = getRun(db, meta.owner, meta.run_id)!;
			if (isTerminalRunStatus(run.status) || run.status === "needs_input")
				return { status: "stale", reason: "browser_interact_not_active" };
			if (!memory.has(meta.run_id)) {
				authority.end(
					db,
					meta.run_id,
					"failed",
					"browser_interact_context_lost",
				);
				return { status: "stale", reason: "browser_interact_context_lost" };
			}
			if (Date.parse(run.deadlineAt!) <= now()) {
				authority.end(db, meta.run_id, "expired", "deadline");
				return { status: "stale", reason: "deadline" };
			}
			if (run.status === "queued")
				transitionRun(db, meta.owner, meta.run_id, "running", {
					nowIso: interactIso(now()),
				});
			return {
				status: "ready",
				input: {
					runId: meta.run_id,
					owner: meta.owner,
					conversationId: meta.conversation_id,
					generation: meta.generation,
					jobId: claim.jobId,
					jobGeneration: claim.generation,
					deadline: Date.parse(run.deadlineAt!),
				},
			};
		},
		execute: (input, ctx) => step(input, ctx.signal),
		settleInTransaction(db, claim, input, outcome) {
			if (!input) {
				const meta = interactMeta(db, claim.payload.runId);
				if (
					meta &&
					meta.job_id === claim.jobId &&
					meta.generation === claim.payload.generation
				)
					authority.end(
						db,
						meta.run_id,
						outcome.type === "expired" ? "expired" : "failed",
						outcome.type === "expired"
							? "deadline"
							: "browser_interact_context_lost",
					);
				return "applied";
			}
			const live = interactMeta(db, input.runId);
			if (
				live?.job_id === claim.jobId &&
				live.generation === input.generation &&
				Date.parse(getRun(db, input.owner, input.runId)!.deadlineAt!) <= now()
			) {
				authority.end(db, input.runId, "expired", "deadline");
				return "applied";
			}
			if (
				live?.job_id === claim.jobId &&
				live.generation === input.generation &&
				memory.get(input.runId)?.source !== undefined &&
				!deps.validSource?.(db, memory.get(input.runId)!.source)
			) {
				authority.end(db, input.runId, "cancelled", "execution_source_invalid");
				return "applied";
			}
			if (
				!input ||
				!authority.current(
					db,
					input.runId,
					input.generation,
					claim.jobId,
					claim.generation,
				)
			)
				return "stale";
			if (outcome.type !== "success") {
				authority.end(
					db,
					input.runId,
					outcome.type === "expired" ? "expired" : "failed",
					outcome.type === "failed" || outcome.type === "interrupted"
						? outcome.errorCode
						: "browser_interact_failed",
				);
				return "applied";
			}
			const meta = interactMeta(db, input.runId)!;
			const result = outcome.result;
			if (result.kind === "continue") {
				db.query(
					"UPDATE browser_interact_runs SET revision=revision+1 WHERE run_id=?",
				).run(meta.run_id);
				enqueue(db, interactMeta(db, meta.run_id)!);
			} else if (result.kind === "question") question(db, meta, result);
			else {
				authority.end(db, input.runId, result.status, result.code);
				memory.get(input.runId)!.answer = result.text;
			}
			return "applied";
		},
		cancelInTransaction(db, job, reason) {
			authority.end(
				db,
				job.payload.runId,
				reason === "deadline" ? "expired" : "cancelled",
				reason === "deadline" ? "deadline" : "cancel_requested",
			);
		},
		afterCommit() {
			scheduleFlush();
		},
	});
	queue.registerHandler<{ runId: string; generation: number }, string, void>({
		kind: EXPIRY,
		payloadVersions: [1],
		schema: payload,
		recovery: "replay_safe",
		prepareInTransaction(db, claim) {
			const meta = interactMeta(db, claim.payload.runId);
			if (!meta) return { status: "stale", reason: "not_found" };
			authority.end(db, meta.run_id, "expired", "deadline");
			return { status: "ready", input: meta.run_id };
		},
		async execute(id) {
			const mem = memory.get(id);
			mem?.controller.abort();
			await mem?.driver?.disconnect();
		},
		settleInTransaction() {
			return "applied";
		},
		cancelInTransaction() {},
		afterCommit() {
			scheduleFlush();
		},
	});

	return enqueue;
}
