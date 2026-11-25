import type { Database } from "bun:sqlite";
import type { AnswerTicket } from "../../agent-runtime";
import type { Run } from "../contracts";
import { researchCitations } from "./research-citations";
import type { DialogueDeps, GenerateInput } from "./context";

/** The run's sub-agent answer waiting to be spoken about, or null (none, or its evidence no longer holds). */
export function answerTicketInTransaction(
	deps: DialogueDeps,
	tx: Database,
	run: Run,
): AnswerTicket | null {
	if (!run.agentTaskId || !deps.agents) return null;
	try {
		return deps.agents.prepareAnswerInTransaction(tx, run.id);
	} catch {
		return null;
	}
}

/**
 * Right before the model speaks, the sub-agent's answer it consumes is read again: a change since the prepare (a
 * write queued before this one) is read here too.
 */
export async function refreshAgentAnswer(
	deps: DialogueDeps,
	input: GenerateInput,
): Promise<void> {
	const agents = deps.agents;
	// One whose evidence no longer holds keeps the old ticket, which the adoption refuses.
	if (input.agent && agents)
		input.agent = await deps.store.write((tx) => {
			try {
				return agents.prepareAnswerInTransaction(tx, input.runId);
			} catch {
				return input.agent!;
			}
		});
}

/**
 * The links of a reply that looked something up are kept to the sources the lookup returned, written in the canonical
 * form. A reply that looked nothing up is left as it is.
 */
export function reportedLinks(
	text: string,
	lookupSources: Array<{ url: string }> = [],
): string {
	if (!text || !lookupSources.length) return text;
	const verified = lookupSources.map(({ url }, index) => ({
		url,
		sourceId: `lookup-${index}`,
	}));
	const projection = JSON.stringify({
		sources: verified,
		claims: [{ sourceIds: verified.map(({ sourceId }) => sourceId) }],
	});
	return researchCitations(text, projection, { requireSources: true });
}

/** Consumes the sub-agent's answer an adopted generation spoke of; one no longer valid is not adopted. */
export function consumeAnswer(
	deps: DialogueDeps,
	tx: Database,
	_run: Run,
	ticket: AnswerTicket,
): boolean {
	const agents = deps.agents;
	if (!agents) return true;
	try {
		// Completing checks the ticket against the answer as it is now.
		agents.completeAnswerInTransaction(tx, ticket);
		return true;
	} catch {
		return false;
	}
}
