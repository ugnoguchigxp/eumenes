import type { Database } from "bun:sqlite";
import {
	reportedTodoIds,
	type ActionTicket,
	type EmotionName,
} from "eumenes-agency";
import { hostDelivery, type DeliveryEmotion } from "../../domains/delivery";
export const deliveryEmotionOf = (emotion: EmotionName): DeliveryEmotion =>
	emotion === "calm" ? "none" : emotion;
import type { AgencyHostDeps } from "./host";
/** Proposal acceptance is separate from the actual speech transcript and playback evidence. */
export type SpeechRouter = (
	db: Database,
	conversationId: string,
	text: string,
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
	}: {
		conversationId: string;
		messageId: string;
		text: string;
		at: number;
		ticket: ActionTicket;
		evidenceRefs: readonly string[];
	},
): "routed" | "appended" {
	if (deps.routeSpeechInTransaction?.(db, conversationId, text))
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
export const speechReceipt = (outcome: "appended" | "routed", text: string) =>
	outcome === "routed"
		? "発話の提案を音声会話の出力先に渡しました。実際の発話・再生は未確認です。"
		: text;
