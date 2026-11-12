import type { Database } from "bun:sqlite";
import { withinJsonLimits } from "eumenes-collaboration";
import type { Source } from "../contracts";
import { pending, sources } from "../repository";
import { fail, hash, json, terminal, type WorkContext } from "./work-context";

export function createChildOperations(context: WorkContext) {
	const {
		host,
		now,
		held,
		authority,
		prior,
		current,
		response,
		record,
		purge,
	} = context;
	function start(
		db: Database,
		input: {
			workRef: string;
			sessionId: string;
			runId: string;
			requestId: string;
			expectedRevision: number;
			value?: unknown;
		},
	) {
		const row = held(db, input.workRef, input.sessionId, input.runId),
			owner = authority(db, row);
		if (row.kind === "schedule") fail("work_not_found");
		const replay = prior(db, row, input.requestId, input);
		if (replay) return replay;
		if (row.revision !== input.expectedRevision) fail("revision_conflict");
		if (row.child_id) {
			const previous = host().view(
				db,
				row.kind,
				current(db, row),
				row.child_id,
			);
			if (
				!previous ||
				!terminal(previous) ||
				previous.status === "indeterminate"
			)
				fail("collaboration_child_exists");
		}
		if (!host().available(db, row.kind)) fail("collaboration_unavailable");
		const source = current(db, row),
			answer = response(db, row, input.runId);
		if (answer.messageId === row.last_start_message_id)
			fail("collaboration_confirmation_required");
		// A separate, real user response is required before running a draft. Host events cannot grant it.
		if (row.kind === "pipeline" && answer.messageId === source.messageId)
			fail("collaboration_confirmation_required");
		const value =
			row.kind === "pipeline" ? json(row.document_json) : input.value;
		const checked = host().check(db, row.kind, value, source);
		if (!checked.ok) fail("collaboration_definition_invalid");
		const history = contributionHistory(db, row.id, row.session_id);
		const result = host().start(db, row.kind, {
			workRef: row.id,
			requestId: input.requestId,
			source,
			response: answer,
			history,
			value: checked.value,
			...(row.child_id ? { previousChildId: row.child_id } : {}),
		});
		if (!withinJsonLimits(result)) fail("collaboration_result_capacity");
		db.query(
			"UPDATE collaboration_works SET child_id=?,child_borrowed=0,child_epoch=?,child_digest=NULL,child_json=?,last_start_message_id=?,revision=revision+1,updated_at=? WHERE id=?",
		).run(
			result.id,
			owner.epoch,
			JSON.stringify(result),
			answer.messageId,
			now(),
			row.id,
		);
		return record(db, row, input.requestId, input, result);
	}
	function attach(
		db: Database,
		input: {
			workRef: string;
			sessionId: string;
			runId: string;
			requestId: string;
			childId: string;
			expectedRevision: number;
		},
	) {
		const row = held(db, input.workRef, input.sessionId, input.runId);
		if (row.kind !== "task") return fail("work_not_found");
		const owner = authority(db, row);
		const user = response(db, row, input.runId);
		const replay = prior(db, row, input.requestId, input);
		if (replay) return replay;
		if (row.revision !== input.expectedRevision)
			return fail("revision_conflict");
		if (row.child_id === input.childId && row.child_epoch === owner.epoch) {
			const existing = host().view(db, row.kind, user, input.childId);
			if (existing) return record(db, row, input.requestId, input, existing);
		}
		if (row.child_id && !row.child_borrowed) {
			const previous = host().view(db, row.kind, user, row.child_id);
			if (!previous || !terminal(previous))
				return fail("collaboration_child_exists");
		}
		const result = host().continuation?.(db, user, input.childId);
		if (!result || !withinJsonLimits(result))
			return fail("execution_not_found");
		db.query(
			"UPDATE collaboration_works SET child_id=?,child_borrowed=1,child_epoch=?,child_digest=NULL,child_json=?,last_start_message_id=?,revision=revision+1,updated_at=? WHERE id=?",
		).run(
			result.id,
			owner.epoch,
			JSON.stringify(result),
			user.messageId,
			now(),
			row.id,
		);
		return record(db, row, input.requestId, input, result);
	}
	function answer(
		db: Database,
		input: {
			workRef: string;
			sessionId: string;
			runId: string;
			requestId: string;
			childRevision: number;
			questionId: string;
			value: unknown;
		},
	) {
		if (!withinJsonLimits(input.value)) fail("collaboration_answer_capacity");
		const row = held(db, input.workRef, input.sessionId, input.runId),
			owner = authority(db, row);
		if (row.kind === "schedule") fail("work_not_found");
		if (row.child_epoch !== owner.epoch || !row.child_id)
			fail("collaboration_child_changed");
		const replay = prior(db, row, input.requestId, input);
		if (replay) return replay;
		const source = current(db, row),
			actual = host().view(db, row.kind, source, row.child_id);
		if (
			!actual?.question ||
			actual.question.id !== input.questionId ||
			actual.revision !== input.childRevision ||
			(actual.question.expiresAt !== undefined &&
				actual.question.expiresAt <= now())
		)
			fail("collaboration_question_closed");
		const user = response(db, row, input.runId);
		if (
			(!row.child_borrowed && user.messageId === source.messageId) ||
			user.messageId === row.last_start_message_id ||
			user.messageId === row.last_answer_message_id
		)
			fail("collaboration_answer_invalid");
		const result = host().answer(
			db,
			row.kind,
			source,
			user,
			actual,
			input.value,
			contributionHistory(db, row.id, row.session_id),
			row.id,
		);
		if (!withinJsonLimits(result)) fail("collaboration_result_capacity");
		db.query(
			"UPDATE collaboration_works SET child_id=?,child_json=?,child_digest=NULL,last_answer_message_id=?,updated_at=? WHERE id=?",
		).run(result.id, JSON.stringify(result), user.messageId, now(), row.id);
		return record(db, row, input.requestId, input, result);
	}
	function contributionHistory(
		db: Database,
		workRef: string,
		sessionId: string,
	) {
		return sources(db, workRef).flatMap(({ run_id }) => {
			const source = host().source(db, run_id);
			return source?.specialistSessionId === sessionId ? [source] : [];
		});
	}
	function amend(
		db: Database,
		input: {
			workRef: string;
			sessionId: string;
			runId: string;
			requestId: string;
			childRevision: number;
			request: string;
		},
	) {
		const row = held(db, input.workRef, input.sessionId, input.runId);
		const owner = authority(db, row);
		if (row.kind !== "task" || !row.child_id || row.child_epoch !== owner.epoch)
			return fail("collaboration_child_changed");
		const user = response(db, row, input.runId);
		const replay = prior(db, row, input.requestId, input);
		if (replay) return replay;
		if (
			row.last_start_message_id === user.messageId ||
			row.last_answer_message_id === user.messageId
		)
			return fail("collaboration_answer_invalid");
		const child = host().view(db, row.kind, user, row.child_id);
		if (!child || terminal(child)) return fail("collaboration_child_changed");
		const result = host().amend?.(
			db,
			user,
			row.child_id,
			input.childRevision,
			input.request,
		);
		if (!result || !withinJsonLimits(result))
			return fail("execution_not_found");
		db.query(
			"UPDATE collaboration_works SET child_json=?,child_digest=NULL,last_answer_message_id=?,updated_at=? WHERE id=?",
		).run(JSON.stringify(result), user.messageId, now(), row.id);
		return record(db, row, input.requestId, input, result);
	}
	function refresh(db: Database, workRef?: string) {
		for (const row of pending(db).filter(
			(row) => workRef === undefined || row.id === workRef,
		)) {
			if (row.kind === "schedule") continue;
			let source: Source;
			try {
				source = current(db, row);
			} catch {
				purge(db, row, true);
				continue;
			}
			const owner = host().authority(db, row.session_id);
			if (!owner?.active || owner.epoch !== row.child_epoch) {
				if (row.child_borrowed) {
					db.query(
						"UPDATE collaboration_works SET child_id=NULL,child_epoch=NULL,child_digest=NULL,child_json=NULL,child_borrowed=0 WHERE id=?",
					).run(row.id);
					continue;
				}
				host().cancel(db, row.kind, source, row.child_id!);
				const stopped = host().view(db, row.kind, source, row.child_id!);
				if (stopped && withinJsonLimits(stopped))
					db.query(
						"UPDATE collaboration_works SET child_json=?,child_digest=?,updated_at=? WHERE id=?",
					).run(JSON.stringify(stopped), hash(stopped), now(), row.id);
				continue;
			}
			const result = host().view(db, row.kind, source, row.child_id!);
			if (!result && row.kind === "task") {
				db.query(
					"UPDATE collaboration_works SET child_id=NULL,child_epoch=NULL,child_digest=NULL,child_json=NULL,child_borrowed=0 WHERE id=?",
				).run(row.id);
				continue;
			}
			if (!result || !withinJsonLimits(result)) continue;
			const digest = hash(result);
			if (digest === row.child_digest) continue;
			if (
				(result.question || terminal(result)) &&
				!host().notify(db, {
					sessionId: row.session_id,
					epoch: owner.epoch,
					sourceRunId: source.runId,
					eventId: `collaboration:${row.id}:${digest}`,
					event: result,
				})
			)
				continue;
			db.query(
				"UPDATE collaboration_works SET child_json=?,child_digest=?,updated_at=? WHERE id=?",
			).run(JSON.stringify(result), digest, now(), row.id);
		}
	}
	return { start, attach, answer, amend, refresh };
}
