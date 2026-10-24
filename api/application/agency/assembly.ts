import type { DialogueService } from "../../domains/dialogue";
import { createAgencyHost, type AgencyHostDeps } from "./host";
import { createAgencyLlmPort } from "./llm-port";

/**
 * The agency host of the server: its background LLM port reads the token counts of a control call from the attempt
 * record, and it learns from the dialogue service (built after it) whether a conversation is busy and records its
 * own utterances there.
 */
export function assembleAgency(
	deps: Pick<
		AgencyHostDeps,
		"store" | "conversation" | "settings" | "memory"
	> & {
		inference: AgencyHostDeps["inference"] &
			Parameters<typeof createAgencyLlmPort>[0]["inference"] & {
				usage(): Array<{
					id: string;
					model: string | null;
					inputTokens: number | null;
					outputTokens: number | null;
				}>;
			};
	},
	dialogue: () => Pick<
		DialogueService,
		"conversationHasActiveRunInTransaction" | "recordSpontaneousInTransaction"
	>,
) {
	const { store, inference } = deps;
	return createAgencyHost({
		...deps,
		conversationBusy: (db, conversationId) =>
			dialogue().conversationHasActiveRunInTransaction(db, conversationId),
		recordSpokeInTransaction: (db, input) =>
			dialogue().recordSpontaneousInTransaction(db, input),
		createLlm: (next) =>
			createAgencyLlmPort({
				store,
				inference,
				next,
				// The receipt of a control call carries no token counts: read them from the attempt record.
				attemptUsage: (attemptId) => {
					const used = inference.usage().find((a) => a.id === attemptId);
					return used
						? {
								model: used.model,
								inputTokens: used.inputTokens,
								outputTokens: used.outputTokens,
								cacheReadTokens: null,
							}
						: null;
				},
			}),
	});
}
