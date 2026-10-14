import type { Database } from "bun:sqlite";
import {
	INTERACTION_POLICY,
	type InteractionQuestion,
	type InteractionStatus,
	type InteractionView,
} from "../contracts/command-interactions";
import {
	bodyBytes,
	insertEvent,
	type InteractionRow,
} from "../repository/interactions";
import type { DialogueDeps } from "./context";

/** Why the receipt of a settled operation is referenced: `adapter:timers@1` -> owner `timers`. */
export function ownerOf(adapterRef: string) {
	return /^adapter:([a-z0-9._-]+)@/.exec(adapterRef)?.[1] ?? adapterRef;
}

/**
 * What every part of the interactions service shares: the view of a row, the frozen-ref check,
 * the event log and the one way an open interaction ends.
 */
export function createInteractionCore(deps: DialogueDeps) {
	const { clock, id } = deps;
	const nowMs = () => Date.parse(clock());

	function view(row: InteractionRow, now = nowMs()): InteractionView {
		const expired =
			row.status === "waiting_input" && Date.parse(row.expiresAt) <= now;
		const question =
			row.status === "waiting_input" &&
			!expired &&
			row.questionId &&
			row.questionPrompt &&
			row.questionSchemaRef
				? {
						questionId: row.questionId,
						prompt: row.questionPrompt,
						inputSchemaRef:
							row.questionSchemaRef as InteractionQuestion["inputSchemaRef"],
						revision: row.revision,
						expiresAt: row.expiresAt,
						...(row.questionChoicesJson
							? { choices: JSON.parse(row.questionChoicesJson) }
							: {}),
					}
				: null;
		return {
			id: row.id,
			conversationId: row.conversationId,
			status: expired ? "expired" : row.status,
			revision: row.revision,
			chainRevisionId: row.chainRevisionId,
			artifactRevisionId: row.artifactRevisionId,
			question,
			questionCount: row.questionCount,
			receiptRef:
				row.receiptOwner && row.receiptOperationId && row.receiptDigest
					? {
							owner: row.receiptOwner,
							operationId: row.receiptOperationId,
							digest: row.receiptDigest,
						}
					: null,
			expiresAt: row.expiresAt,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		};
	}

	/**
	 * The frozen refs must still be what the catalog offers: the chain revision active, its
	 * package available, and the binding unchanged. Anything else stops the operation.
	 */
	function frozenValid(tx: Database, row: InteractionRow) {
		const toolchains = deps.toolchains;
		if (!toolchains?.bound) return false;
		try {
			const resolved = toolchains.resolveInTransaction(tx, row.chainRevisionId);
			if (resolved.packageRevisionId !== row.packageRevisionId) return false;
			const set = toolchains.commandSetInTransaction(tx, row.chainRevisionId);
			return (
				set.binding?.bindingRevisionId === row.bindingRevisionId &&
				set.binding.packageRevisionId === row.packageRevisionId
			);
		} catch {
			return false;
		}
	}

	/** The answer field the frozen binding fills from host choices for this question's schema. */
	function choiceFieldOf(tx: Database, row: InteractionRow) {
		try {
			return deps.toolchains
				?.commandSetInTransaction(tx, row.chainRevisionId)
				.binding?.questions.find(
					(q) => q.inputSchemaRef === row.questionSchemaRef,
				)?.choiceField;
		} catch {
			return undefined;
		}
	}

	function addEvent(
		tx: Database,
		interactionId: string,
		kind: "question" | "answer" | "invoke" | "cancel" | "end",
		eventId: string,
		payload: unknown,
	) {
		insertEvent(tx, {
			id: id(),
			interactionId,
			kind,
			eventId,
			createdAt: clock(),
			payload,
		});
	}

	function checkBody(tx: Database, interactionId: string) {
		if (bodyBytes(tx, interactionId) > INTERACTION_POLICY.maxBodyBytes)
			throw new Error("interaction_body_too_large");
	}

	/** Move an open interaction to a terminal status; a no-op when it already ended. */
	function settle(
		tx: Database,
		row: InteractionRow,
		status: Extract<
			InteractionStatus,
			"completed" | "cancelled" | "expired" | "indeterminate"
		>,
		code: string | null,
		receipt?: { owner: string; operationId: string; digest: string },
	) {
		const now = clock();
		const done = status === "completed";
		const changes = tx
			.query(
				`UPDATE command_interactions SET status=?,revision=revision+1,
				 authority_epoch=authority_epoch+?,execution_generation=execution_generation+?,
				 question_id=NULL,end_code=?,ended_at=?,updated_at=?,
				 receipt_owner=COALESCE(?,receipt_owner),receipt_operation_id=COALESCE(?,receipt_operation_id),receipt_digest=COALESCE(?,receipt_digest)
				 WHERE id=? AND status IN ('waiting_input','ready','invoking') AND revision=?`,
			)
			.run(
				status,
				done ? 0 : 1,
				done ? 0 : 1,
				code,
				now,
				now,
				receipt?.owner ?? null,
				receipt?.operationId ?? null,
				receipt?.digest ?? null,
				row.id,
				row.revision,
			).changes;
		if (changes !== 1) return false;
		addEvent(tx, row.id, "end", `end:${row.id}:${row.revision + 1}`, {
			status,
			code,
		});
		return true;
	}

	function expireDue(tx: Database, row: InteractionRow) {
		if (row.status !== "waiting_input" || Date.parse(row.expiresAt) > nowMs())
			return false;
		settle(tx, row, "expired", "interaction_expired");
		return true;
	}
	return {
		nowMs,
		view,
		frozenValid,
		choiceFieldOf,
		addEvent,
		checkBody,
		settle,
		expireDue,
	};
}
export type InteractionCore = ReturnType<typeof createInteractionCore>;
