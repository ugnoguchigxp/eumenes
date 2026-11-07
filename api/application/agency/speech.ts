import type { Database } from "bun:sqlite";
import {
	reportedTodoIds,
	type ActionTicket,
	type ActionReceipt,
	type EmotionName,
} from "eumenes-agency";
import { hostDelivery, type DeliveryEmotion } from "../../domains/delivery";
export const deliveryEmotionOf = (emotion: EmotionName): DeliveryEmotion =>
	emotion === "calm" ? "none" : emotion;
import type { AgencyHostDeps } from "./host";
import type { InputContext } from "eumenes-agency";
/** Proposal acceptance is separate from the actual speech transcript and playback evidence. */
export type SpeechRouter = (
	db: Database,
	conversationId: string,
	text: string,
	origin?: { id: string; ordinal: number; input: InputContext },
) => boolean;
export function persistSpeech(
	deps: AgencyHostDeps,
	db: Database,
	{
		conversationId,
		messageId,
		text,
		at,
		ticket,
		evidenceRefs,
		input,
	}: {
		conversationId: string;
		messageId: string;
		text: string;
		at: number;
		ticket: ActionTicket;
		evidenceRefs: readonly string[];
		input: InputContext;
	},
): "routed" | "appended" {
	if (
		deps.routeSpeechInTransaction?.(db, conversationId, text, {
			id: messageId,
			ordinal: deps.conversation.latestOrdinalInTransaction(db, conversationId),
			input,
		})
	)
		return "routed";
	deps.conversation.appendInTransaction(db, {
		id: messageId,
		conversationId,
		role: "assistant",
		text,
		createdAt: new Date(at).toISOString(),
		runId: null,
		...(ticket.emotion
			? { delivery: hostDelivery(deliveryEmotionOf(ticket.emotion)) }
			: {}),
	});
	deps.memory.referenceInputs?.recordMessageInTransaction(db, messageId, input);
	const todoRefs = reportedTodoIds(evidenceRefs);
	deps.recordSpokeInTransaction(db, {
		conversationId,
		messageId,
		text,
		at: new Date(at).toISOString(),
		...(todoRefs.length ? { todoRefs } : {}),
	});
	return "appended";
}
export const speechReceipt = (
	outcome: "appended" | "routed",
	text: string,
): Omit<ActionReceipt, "ticketId" | "at"> =>
	outcome === "routed"
		? {
				status: "succeeded",
				speechHandoff: true,
				resultText:
					"発話の提案を音声会話の出力先に渡しました。実際の発話・再生は未確認です。",
			}
		: { status: "succeeded", resultText: text };
