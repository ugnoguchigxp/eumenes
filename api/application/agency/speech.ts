import type { Database } from "bun:sqlite";
import type { ActionTicket, EmotionName } from "eumenes-agency";
import { hostDelivery, type DeliveryEmotion } from "../../domains/delivery";
export const deliveryEmotionOf = (emotion: EmotionName): DeliveryEmotion =>
	emotion === "calm" ? "none" : emotion;
import type { AgencyHostDeps } from "./host-types";
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
		input,
	}: {
		conversationId: string;
		messageId: string;
		text: string;
		at: number;
		ticket: Pick<ActionTicket, "emotion" | "findingWorkRefs">;
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
	deps.recordSpokeInTransaction(db, {
		conversationId,
		messageId,
		text,
		at: new Date(at).toISOString(),
	});
	deps.state?.linkFindingsInTransaction(
		db,
		conversationId,
		messageId,
		ticket.findingWorkRefs ?? [],
	);
	return "appended";
}
