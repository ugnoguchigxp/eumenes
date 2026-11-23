import { z } from "zod";
import { canAcceptConversation } from "eumenes-canvas/src/core/service";
import type { Database } from "bun:sqlite";
import type { ConversationService } from "../../domains/conversation";
import {
	isStandardExecutionSource,
	type AdapterOrigin,
} from "../../domains/tool-runtime";
import { sha256Hex } from "../../infrastructure/digest";

const text = z
	.string()
	.min(1)
	.max(4000)
	.refine((value) => value.trim().length > 0);
export const canvasJobInput = z.strictObject({
	conversationId: z.string().min(1).max(128),
	message: text,
	conversation: z
		.array(z.strictObject({ role: z.enum(["user", "assistant"]), text }))
		.max(20)
		.refine(canAcceptConversation)
		.optional(),
	artworkId: z
		.string()
		.regex(/^a_[A-Za-z0-9_-]{12}$/)
		.optional(),
	expectedBase: z
		.strictObject({
			revision: z.number().int().min(1),
			digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
		})
		.optional(),
	targetRef: z.string().optional(),
	modelCallLimit: z.number().int().min(1).max(6).optional(),
	sourceRefs: z
		.array(z.strictObject({ messageId: z.string(), digest: z.string() }))
		.max(22)
		.optional(),
});
export type CanvasJobInput = z.infer<typeof canvasJobInput>;
type Messages = Pick<ConversationService, "messageInTransaction">;

/** 既存のChildExecution.resumeが保持する質問の列。本文の意味を解釈しない。 */
function resumedQuestions(value: unknown, depth = 0): string[] {
	if (depth > 20) throw new Error("canvas_input_capacity");
	if (typeof value === "string") return [value];
	if (!value || typeof value !== "object") return [];
	const history = value as { earlier?: unknown; question?: unknown };
	return [
		...resumedQuestions(history.earlier, depth + 1),
		...(typeof history.question === "string" ? [history.question] : []),
	];
}

export function canvasSourcesValid(
	db: Database,
	conversation: Messages,
	input: CanvasJobInput,
) {
	return (
		!!input.sourceRefs?.length &&
		input.sourceRefs.every((ref) => {
			const row = conversation.messageInTransaction(db, ref.messageId)?.message;
			return (
				row?.role === "user" &&
				row.conversationId === input.conversationId &&
				sha256Hex(row.text) === ref.digest
			);
		})
	);
}

/** 本文はホストの依頼注入または検証済みtask source。モデルによる書換えを採用しない。 */
export function canvasRequest(
	db: Database,
	conversation: Messages,
	origin: Extract<AdapterOrigin, { kind: "conversation" | "task" }>,
	request: string | undefined,
	messageIds: readonly string[] = [],
) {
	const source = origin.messageId
		? conversation.messageInTransaction(db, origin.messageId)?.message
		: null;
	if (
		!source ||
		source.role !== "user" ||
		source.conversationId !== origin.conversationId
	)
		throw new Error("execution_source_invalid");
	let message = request ?? source.text;
	const turns: Array<{ role: "user" | "assistant"; text: string }> = [];
	const ids = new Set([source.id, ...messageIds]);
	if (origin.kind === "task") {
		const { source: original, resume } = origin.execution;
		if (!isStandardExecutionSource(original))
			throw new Error("execution_source_invalid");
		message = original.request;
		const questions = resumedQuestions(resume?.previous);
		const answered = questions.length
			? (original.responses ?? []).slice(-questions.length)
			: [];
		const questioned = new Map(
			answered.map((update, index) => [update.messageId, questions[index]]),
		);
		const updates = [
			...(original.amendments ?? []),
			...(original.responses ?? []),
		]
			.map((update) => {
				const row = conversation.messageInTransaction(db, update.messageId);
				if (
					!row ||
					row.message.role !== "user" ||
					row.message.conversationId !== origin.conversationId
				)
					throw new Error("execution_source_invalid");
				ids.add(update.messageId);
				return { ...update, ordinal: row.ordinal };
			})
			.sort((a, b) => a.ordinal - b.ordinal);
		for (const update of updates) {
			const question = questioned.get(update.messageId);
			if (question) turns.push({ role: "assistant", text: question });
			turns.push({ role: "user", text: update.request });
		}
		if (resume && !ids.has(resume.answerMessageId)) {
			ids.add(resume.answerMessageId);
			const question = questions.at(-1);
			if (question) turns.push({ role: "assistant", text: question });
			const answer = conversation.messageInTransaction(
				db,
				resume.answerMessageId,
			)?.message;
			if (
				!answer ||
				answer.role !== "user" ||
				answer.conversationId !== origin.conversationId
			)
				throw new Error("execution_source_invalid");
			turns.push({ role: "user", text: answer.text });
		}
	}
	const sourceRefs = [...ids].map((messageId) => {
		const row = conversation.messageInTransaction(db, messageId)?.message;
		if (
			!row ||
			row.role !== "user" ||
			row.conversationId !== origin.conversationId
		)
			throw new Error("execution_source_invalid");
		return { messageId, digest: sha256Hex(row.text) };
	});
	const checked = canvasJobInput.safeParse({
		conversationId: origin.conversationId,
		message,
		conversation: turns,
		sourceRefs,
	});
	if (!checked.success) throw new Error("canvas_input_capacity");
	return checked.data;
}
