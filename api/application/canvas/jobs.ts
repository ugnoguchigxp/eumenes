import { createHash } from "node:crypto";
import { ServiceError } from "eumenes-canvas/src/core/service";
import type { Database } from "bun:sqlite";
import type { QueueService } from "../../domains/queue";
import type { ConversationService } from "../../domains/conversation";
import type { SqliteStore } from "../../infrastructure/sqlite";
import type { CanvasRuntime } from "./runtime";
import { canvasOwner } from "./runtime";
import {
	canvasJobInput,
	canvasSourcesValid,
	type CanvasJobInput,
} from "./input";

export const canvasJobKind = "canvas.produce";

export function createCanvasJobs(
	queue: QueueService,
	runtime: CanvasRuntime,
	store: SqliteStore,
	conversation: Pick<
		ConversationService,
		"messageInTransaction" | "appendInTransaction"
	>,
) {
	const invalidated = new Set<string>();
	runtime.setCandidateAccess((run) => {
		if (run.authority?.kind === "direct") return true;
		if (
			run.authority?.kind !== "external" ||
			run.authority.ref !== run.requestKey
		)
			return false;
		const ref = run.authority.ref;
		return store.read((db) => {
			const row = queue.getInTransaction(db, ref);
			if (
				!row ||
				row.kind !== canvasJobKind ||
				row.state !== "completed" ||
				row.payloadVersion !== 2 ||
				row.resultRef !== run.id
			)
				return false;
			const input = canvasJobInput.safeParse(JSON.parse(row.payloadJson));
			return input.success && canvasSourcesValid(db, conversation, input.data);
		});
	});
	// Queue's failed settlement returns before its handler afterCommit hook.
	// Observe committed state so a rollback can never revoke a valid run.
	store.onCommit(() => {
		for (const id of invalidated) {
			const row = queue.get(id);
			if (!row || row.state !== "running") {
				invalidated.delete(id);
				if (
					row?.state !== "failed" ||
					row.errorCode !== "canvas_source_changed" ||
					!runtime.ready()
				)
					continue;
				const run = runtime.service.findRunByRequest(canvasOwner, id);
				if (run)
					void runtime.service.cancelRun(canvasOwner, run.id).catch(() => {});
			}
		}
	});
	queue.registerHandler({
		kind: canvasJobKind,
		payloadVersions: [1, 2],
		schema: canvasJobInput,
		recovery: "interrupt",
		prepareInTransaction: (db, claim) =>
			claim.payloadVersion !== 2
				? { status: "stale", reason: "canvas_request_version_expired" }
				: !canvasSourcesValid(db, conversation, claim.payload)
					? { status: "stale", reason: "canvas_source_changed" }
					: { status: "ready", input: claim.payload },
		async execute(input, { signal, jobId }) {
			signal.throwIfAborted();
			const service = runtime.service;
			const session = createHash("sha256")
				.update(input.conversationId)
				.digest("base64url");
			const canAdopt = () =>
				!signal.aborted &&
				store.read((db) => canvasSourcesValid(db, conversation, input));
			if (!canAdopt()) throw new Error("canvas_source_changed");
			const run = await service
				.startRun(
					canvasOwner,
					session,
					{
						...input,
						requestKey: jobId,
						authority: { kind: "external", ref: jobId },
					},
					canAdopt,
				)
				.catch((error) => {
					if (error instanceof ServiceError && error.extra.code === "conflict")
						throw new Error("canvas_revision_conflict");
					throw new Error("canvas_start_failed");
				});
			const cancel = () => service.cancelRun(canvasOwner, run.id);
			let cancelled: ReturnType<typeof cancel> | undefined;
			const abort = () => {
				cancelled = cancel();
				void cancelled.catch(() => {});
			};
			signal.addEventListener("abort", abort, { once: true });
			try {
				if (signal.aborted) abort();
				await service.inflight.get(run.id);
				await cancelled;
				signal.throwIfAborted();
				if (!canAdopt()) throw new Error("canvas_source_changed");
				const result = service.getRun(canvasOwner, run.id);
				if (result.failureCode === "model-budget")
					throw new Error("canvas_model_budget");
				if (result.state !== "presented" || !result.presentedCandidateId)
					throw new Error("canvas_generation_failed");
				return run.id;
			} finally {
				signal.removeEventListener("abort", abort);
			}
		},
		settleInTransaction(db, claim, _input, outcome) {
			const stale =
				outcome.type === "success" &&
				!canvasSourcesValid(db, conversation, claim.payload);
			const settled = stale
				? { type: "failed" as const, errorCode: "canvas_source_changed" }
				: outcome;
			if (outcome.type === "success" && !stale)
				outcome.resultRef = outcome.result;
			const id = `canvas-notice:${claim.jobId}`;
			if (!conversation.messageInTransaction(db, id)) {
				conversation.appendInTransaction(db, {
					id,
					conversationId: claim.payload.conversationId,
					role: "assistant",
					text:
						settled.type === "success"
							? "Canvasアプリの候補を用意しました。アーティファクトで操作できます。"
							: settled.type === "expired"
								? "Canvasアプリの制作は期限を過ぎました。アーティファクトで状態を確認できます。"
								: settled.type === "interrupted"
									? "Canvasアプリの制作は中断しました。アーティファクトで状態を確認できます。"
									: "Canvasアプリの制作を完了できませんでした。アーティファクトで状態を確認できます。",
					createdAt: new Date().toISOString(),
					runId: null,
				});
			}
			if (stale) {
				invalidated.add(claim.jobId);
				return { status: "failed", errorCode: "canvas_source_changed" };
			}
			return "applied";
		},
		cancelInTransaction() {},
	});
	function job(id: string) {
		const row = queue.get(id);
		return row?.kind === canvasJobKind ? row : null;
	}
	return {
		visibleRun(id: string) {
			const run = runtime.service.getRun(canvasOwner, id);
			if (run.state !== "presented" || !run.presentedCandidateId)
				return { ...run, presentedCandidateId: null, candidates: [] };
			if (
				runtime.service.canUseCandidate(canvasOwner, run.presentedCandidateId)
			)
				return run;
			const pending =
				run.authority?.kind === "external"
					? job(run.authority.ref)?.state
					: undefined;
			return {
				...run,
				state:
					pending === "running" || pending === "queued"
						? ("running" as const)
						: ("failed" as const),
				failure: "候補の採用元を確認できません",
				presentedCandidateId: null,
				candidates: [],
			};
		},
		submit(
			db: Database,
			input: CanvasJobInput,
			requestId: string,
			deadline?: number,
		) {
			if (Buffer.byteLength(JSON.stringify(input)) > 16 * 1024)
				throw new Error("canvas_input_capacity");
			return queue.enqueueInTransaction(db, {
				kind: canvasJobKind,
				payloadVersion: 2,
				scope: "canvas",
				lane: "interactive",
				dedupeKey: requestId,
				payload: input,
				subjectRef: input.conversationId,
				deadlineAtMs: deadline ?? Date.now() + 180_000,
				maxAttempts: 1,
			});
		},
		byRequest: (db: Database, id: string) =>
			queue.findByDedupeInTransaction(db, "canvas", canvasJobKind, id),
		latest(conversationId: string) {
			const item = queue.list(
				{ scope: "canvas", kind: canvasJobKind, subjectRef: conversationId },
				null,
				1,
			).items[0];
			return item ? job(item.id) : null;
		},
		job,
		runOf(id: string) {
			const row = job(id);
			if (!row || !runtime.ready()) return null;
			const run = runtime.service.findRunByRequest(canvasOwner, id);
			return run
				? runtime.service.getRun(canvasOwner, run.id)
				: row.resultRef
					? runtime.service.getRun(canvasOwner, row.resultRef)
					: null;
		},
		cancelInTransaction(db: Database, requestId: string) {
			const row = queue.findByDedupeInTransaction(
				db,
				"canvas",
				canvasJobKind,
				requestId,
			);
			if (row) queue.cancelInTransaction(db, row.id, "cancel_requested");
		},
		flushCancellation(requestId: string) {
			const row = store.read((db) =>
				queue.findByDedupeInTransaction(db, "canvas", canvasJobKind, requestId),
			);
			if (!row) return false;
			queue.flushCancellations([row.id]);
			return row.state === "cancelled";
		},
		cancel: (id: string) => (job(id) ? queue.cancel(id) : null),
		wake: () => queue.wake(),
	};
}
export type CanvasJobs = ReturnType<typeof createCanvasJobs>;
