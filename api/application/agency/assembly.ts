import { createAgencyStatePort } from "../../domains/dialogue";
import type { DialogueService } from "../../domains/dialogue";
import type { AgencyHostDeps } from "./host";
import { createSwitchingAgencyHost } from "./switching-host";
import { createAgencyLlmPort } from "./llm-port";

/**
 * The agency host of the server: its background LLM port reads the token counts of a control call from the attempt
 * record, and it learns from the dialogue service (built after it) whether a conversation is busy and records its
 * own utterances there.
 */
export function assembleAgency(
	deps: {
		research?: Omit<Parameters<typeof createAgencyStatePort>[0], "now">;
	} & Pick<
		AgencyHostDeps,
		| "store"
		| "conversation"
		| "settings"
		| "memory"
		| "routeSpeechInTransaction"
		| "state"
		| "steering"
		| "researchRevision"
		| "noteDocuments"
		| "publish"
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
		| "conversationHasActiveRunInTransaction"
		| "recordSpontaneousInTransaction"
		| "conversationTaskInTransaction"
	>,
) {
	const { store, inference } = deps;
	const state =
		deps.state ??
		(deps.research
			? createAgencyStatePort({
					...deps.research,
					...(deps.memory.referenceInputs
						? { memory: { referenceInputs: deps.memory.referenceInputs } }
						: {}),
					now: Date.now,
				})
			: undefined);
	return createSwitchingAgencyHost({
		...deps,
		...(state ? { state } : {}),
		captureContext: (conversationId) =>
			store.read((db) => {
				const captured = dialogue().conversationTaskInTransaction(
					db,
					conversationId,
					"",
					{ requireProvenance: true },
				);
				return captured
					? {
							messages: structuredClone(captured.messages),
							input: captured.input ?? { sources: [], complete: false },
						}
					: null;
			}),
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
