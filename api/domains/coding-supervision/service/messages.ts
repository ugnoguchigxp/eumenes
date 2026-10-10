import type { MessageMetadata } from "../../../../packages/coding-runner/src/contracts";

export interface ReportMessage {
	seq: number;
	ref: string;
	metadata: MessageMetadata;
}
/**
 * Picks which public messages go into the bounded supervision context. Pure and deterministic;
 * a message is never promoted to final by position or wording. Callers get at most one per slot:
 * the explicit final, the newest explicit commentary, the newest of unknown kind.
 */
export function selectReportMessages(messages: ReportMessage[]) {
	const newest = (kind: MessageMetadata["messageKind"]) =>
		messages
			.filter((m) => m.metadata.messageKind === kind)
			.sort((a, b) => b.seq - a.seq)[0] ?? null;
	const final = newest("final_answer"),
		commentary = newest("commentary"),
		unknown = newest("unknown");
	const chosen = [final, commentary, unknown].filter(
		(m): m is ReportMessage => m !== null,
	);
	return {
		final,
		commentary,
		unknown,
		chosen,
		/** Selection dropped some messages, so the context must say so. */
		omitted: messages.length - chosen.length,
	};
}
