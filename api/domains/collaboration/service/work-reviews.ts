import type { Database } from "bun:sqlite";
import { withinJsonLimits } from "eumenes-collaboration";
import { z } from "zod";
import type { QueueService } from "../../queue";
import type { ReviewInput, ReviewOutcome } from "../contracts";
import {
	reviewOf,
	work,
	writeReview,
	type ReviewRow,
	type WorkRow,
} from "../repository";
import { fail, hash, json, type WorkContext } from "./work-context";

const KIND = "collaboration.review";
const REVIEW_MS = 120_000;
const DELIVERY_MS = 300_000;
const payloadSchema = z.strictObject({
	workRef: z.uuid(),
	id: z.uuid(),
	phase: z.enum(["evaluate", "deliver"]),
	deadline: z.number(),
});
type Payload = z.infer<typeof payloadSchema>;
type Prepared =
	| { phase: "deliver" }
	| { phase: "evaluate"; payload: Payload; review: ReviewInput };
const failure: ReviewOutcome = {
	status: "failed",
	summary: "下書きの評価を完了できませんでした。",
};
const changed: ReviewOutcome = {
	status: "cancelled",
	summary: "条件が変わりました。現在の版を評価し直してください。",
};

export function createWorkReviews(context: WorkContext, queue?: QueueService) {
	const { host, now, held, authority, current, response, prior, record } =
		context;
	const conditions = (db: Database, sessionId: string) =>
		host().review?.conditions(db, sessionId) ?? {
			state: "unavailable" as const,
		};
	function live(db: Database, payload: Payload) {
		const row = work(db, payload.workRef);
		const review = row && reviewOf(row);
		if (
			!row ||
			row.ended ||
			!review ||
			review.id !== payload.id ||
			review.revision !== row.revision
		)
			return null;
		try {
			const source = current(db, row);
			if (authority(db, row).epoch !== review.epoch) return null;
			const user = response(db, row, review.runId);
			return { row, review, source, user };
		} catch {
			return null;
		}
	}
	function enqueue(
		db: Database,
		payload: Payload,
		dedupeKey: string,
		at = now(),
	) {
		return queue!.enqueueInTransaction(db, {
			scope: "collaboration",
			kind: KIND,
			payload,
			dedupeKey,
			subjectRef: payload.workRef,
			lane: "background",
			concurrencyKey: `collaboration-review:${payload.workRef}`,
			deadlineAtMs: payload.deadline,
			availableAtMs: at,
			maxAttempts: 1,
		}).job.id;
	}
	function deliver(db: Database, review: ReviewRow, row: WorkRow) {
		const outcome =
			review.conditions !== undefined &&
			review.conditions !== hash(conditions(db, row.session_id))
				? changed
				: review.outcome!;
		if (outcome === changed)
			writeReview(db, row.id, { ...review, outcome, conditions: undefined });
		return host().notify(db, {
			sessionId: row.session_id,
			epoch: review.epoch,
			sourceRunId: review.runId,
			eventId: `collaboration-review:${review.id}`,
			event: {
				kind: "review",
				id: review.id,
				revision: review.revision,
				...outcome,
			},
		});
	}
	function complete(
		db: Database,
		payload: Payload,
		row: WorkRow,
		review: ReviewRow,
		outcome: ReviewOutcome,
		conditionDigest?: string,
	) {
		const bounded =
			withinJsonLimits(outcome) && JSON.stringify(outcome).length <= 14500
				? outcome
				: {
						status: "incomplete" as const,
						summary: "評価結果が表示の上限を超えました。",
					};
		const saved = { ...review, outcome: bounded, conditions: conditionDigest };
		writeReview(db, row.id, saved);
		if (!deliver(db, saved, row)) {
			const next = {
				...payload,
				phase: "deliver" as const,
				deadline: now() + DELIVERY_MS,
			};
			enqueue(db, next, `${review.id}:deliver`, now() + 1000);
		}
	}
	queue?.registerHandler<Payload, Prepared, ReviewOutcome | null>({
		kind: KIND,
		payloadVersions: [1],
		schema: payloadSchema,
		recovery: "interrupt",
		prepareInTransaction(db, claim) {
			const target = live(db, claim.payload);
			if (!target)
				return { status: "stale", reason: "collaboration_review_stale" };
			if (claim.payload.phase === "deliver")
				return target.review.outcome
					? { status: "ready", input: { phase: "deliver" } }
					: { status: "stale", reason: "collaboration_review_pending" };
			if (target.review.outcome || !host().review)
				return { status: "stale", reason: "collaboration_review_stale" };
			const { row, source, user, review } = target;
			return {
				status: "ready",
				input: {
					phase: "evaluate",
					payload: claim.payload,
					review: {
						id: review.id,
						workRef: row.id,
						revision: row.revision,
						document: json(row.document_json),
						source,
						request: user.request,
						requestMessageId: user.messageId,
						conditions: conditions(db, row.session_id),
					},
				},
			};
		},
		async execute(input, job) {
			if (input.phase === "deliver") return null;
			const { review, payload } = input;
			const fingerprint = hash(review.conditions);
			return host().review!.evaluate(
				review,
				payload.deadline,
				job.signal,
				(db) => {
					const target = live(db, payload);
					return (
						!!target &&
						!target.review.outcome &&
						now() < payload.deadline &&
						hash(conditions(db, target.row.session_id)) === fingerprint
					);
				},
			);
		},
		settleInTransaction(db, claim, input, result) {
			const { payload } = claim;
			const target = live(db, payload);
			if (!target) return "stale";
			const { row, review } = target;
			if (payload.phase === "deliver") {
				if (
					!review.outcome ||
					result.type !== "success" ||
					now() >= payload.deadline
				)
					return "stale";
				if (!deliver(db, review, row))
					enqueue(db, payload, `${claim.jobId}:retry`, now() + 1000);
				return "applied";
			}
			if (review.outcome) return "stale";
			const fingerprint =
				input?.phase === "evaluate" ? hash(input.review.conditions) : undefined;
			if (
				fingerprint !== undefined &&
				hash(conditions(db, row.session_id)) !== fingerprint
			)
				complete(db, payload, row, review, changed);
			else
				complete(
					db,
					payload,
					row,
					review,
					result.type === "success" && result.result && now() < payload.deadline
						? result.result
						: failure,
					fingerprint,
				);
			return "applied";
		},
		cancelInTransaction(db, job, reason) {
			if (job.payload.phase !== "evaluate") return;
			const target = live(db, job.payload);
			if (target && !target.review.outcome)
				complete(
					db,
					job.payload,
					target.row,
					target.review,
					reason === "deadline_exceeded"
						? failure
						: {
								status: "cancelled",
								summary: "下書きの評価を中止しました。",
							},
				);
		},
		afterCommit: () => queue.wake(),
	});

	function invalidate(db: Database, row: WorkRow) {
		const review = reviewOf(row);
		if (!review) return;
		writeReview(db, row.id, null);
		if (
			!review.outcome &&
			queue?.cancelInTransaction(db, review.jobId, "review_superseded")
				?.wasRunning
		)
			queueMicrotask(() => queue.flushCancellations([review.jobId]));
	}
	return {
		start(
			db: Database,
			input: {
				workRef: string;
				sessionId: string;
				runId: string;
				requestId: string;
				expectedRevision: number;
			},
		) {
			const row = held(db, input.workRef, input.sessionId, input.runId);
			const owner = authority(db, row);
			response(db, row, input.runId);
			const replay = prior(db, row, input.requestId, input);
			if (replay) return replay;
			if (row.kind !== "pipeline" || !queue || !host().review)
				return fail("collaboration_review_unavailable");
			if (row.revision !== input.expectedRevision)
				return fail("revision_conflict");
			if (!row.document_json) return fail("collaboration_review_draft_missing");
			const previous = reviewOf(row);
			if (
				previous?.epoch === owner.epoch &&
				(!previous.outcome || previous.runId === input.runId)
			)
				return fail("collaboration_review_already_requested");
			if (previous) invalidate(db, row);
			const id = crypto.randomUUID();
			const payload: Payload = {
				workRef: row.id,
				id,
				phase: "evaluate",
				deadline: now() + REVIEW_MS,
			};
			const jobId = enqueue(db, payload, id);
			writeReview(db, row.id, {
				id,
				revision: row.revision,
				epoch: owner.epoch,
				runId: input.runId,
				jobId,
			});
			return record(db, row, input.requestId, input, {
				id,
				revision: row.revision,
				status: "running",
			});
		},
		cancel(
			db: Database,
			input: { workRef: string; sessionId: string; runId: string },
		) {
			const row = held(db, input.workRef, input.sessionId, input.runId);
			authority(db, row);
			response(db, row, input.runId);
			invalidate(db, row);
		},
		invalidate,
		view(db: Database, row: WorkRow) {
			const review = reviewOf(row);
			if (
				!review ||
				review.revision !== row.revision ||
				host().authority(db, row.session_id)?.epoch !== review.epoch
			)
				return null;
			const outcome =
				review.conditions !== undefined &&
				review.conditions !== hash(conditions(db, row.session_id))
					? changed
					: review.outcome;
			return {
				id: review.id,
				revision: review.revision,
				...(outcome ?? { status: "running" as const }),
			};
		},
	};
}
