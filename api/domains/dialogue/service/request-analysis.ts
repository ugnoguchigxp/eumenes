import type { Receipt } from "../../inference";
import { systemContext } from "../../../infrastructure/system-context";
import { getLogger } from "../../../infrastructure/logger";
import type { DialogueDeps, GenerateInput } from "./context";
import { omitted } from "./context-fit";
import type { HistoryTurn, PersonaSpec } from "./context-assembly";
import { generateConversation } from "./conversation-generation";
import { analysisTools, type FirstRound } from "./initial-decision";
import { currentRequestMessage, markCurrentRequest } from "./request-context";
import {
	decisionDraft,
	recordRejected,
	type Candidates,
} from "./selection-trace";
import { buildRolePrompt } from "./system-prompt";

const log = getLogger("dialogue");

/**
 * What the first round reads besides the current request: the persona (role and tone) and the one exchange
 * just before it, verbatim. Long-term memory, history, summaries, notes, recall, goals and the time stay out.
 */
export type AnalysisInput = {
	persona: PersonaSpec;
	previous: Array<{ role: "user" | "assistant"; content: string }>;
};

/** The characters of each message of the previous exchange the first round reads; the rest is cut from the end. */
export const PREVIOUS_MESSAGE_MAX_CHARS = 600;

function clipMessage(content: string) {
	const chars = [...content];
	return chars.length <= PREVIOUS_MESSAGE_MAX_CHARS
		? content
		: chars.slice(0, PREVIOUS_MESSAGE_MAX_CHARS).join("") +
				omitted(chars.length - PREVIOUS_MESSAGE_MAX_CHARS);
}

/**
 * The newest exchange of the shown history: its last answer with the user message before it, or a lone last
 * message. Each message is cut to `PREVIOUS_MESSAGE_MAX_CHARS` characters.
 */
export function previousExchange(
	turns: readonly HistoryTurn[],
): AnalysisInput["previous"] {
	const last = turns.at(-1);
	if (!last) return [];
	const before = turns.at(-2);
	return (
		last.role === "assistant" && before?.role === "user"
			? [before, last]
			: [last]
	).map(({ role, content }) => ({ role, content: clipMessage(content) }));
}

/**
 * The first round of every new conversation decision: one call, one of the candidates' functions, `answer` or
 * `report_unavailable`; its prose is neither shown nor adopted. The structural repair is the shared one
 * (once); a second violation fails.
 */
export async function analyzeRequest(
	deps: DialogueDeps,
	input: GenerateInput,
	found: Candidates,
	signal: AbortSignal,
	repair: () => void,
): Promise<{ analysis: FirstRound; receipt?: Receipt; repaired: boolean }> {
	const started = Date.now();
	const analysis = input.routing!.analysis;
	const current = currentRequestMessage(input);
	const messages = markCurrentRequest(
		[
			{ role: "system", content: buildRolePrompt(analysis.persona) },
			...(analysis.previous.length
				? [
						{
							role: "user" as const,
							content:
								systemContext(
									"dialogue.contexts.request-analysis.previous",
									{},
								) + JSON.stringify(analysis.previous),
						},
					]
				: []),
			// Right before the request: a reply the previous turn happened to give must not set the form of this call.
			{
				role: "system",
				content: systemContext(
					"dialogue.contexts.request-analysis.instruction",
					{},
				),
			},
			current,
		],
		current,
		input.currentRequest.messageId,
	);
	try {
		const generated = await generateConversation({
			inference: deps.larm,
			requestId: input.requestId,
			messages,
			requestMessage: current,
			signal,
			delta: () => {},
			briefReply: input.briefReply,
			tools: analysisTools(found.route.cards, found.sessions),
			cards: found.route.cards,
			analysis: true,
			// A one-shot call: its prose is never adopted and it holds no conversation session.
			sessionRole: "auxiliary",
			repair,
		});
		const result = generated.analysis!;
		log.info("dialogue.request_analyzed", {
			kind: result.kind,
			freshness: result.freshness,
			next: result.next,
			durationMs: Date.now() - started,
		});
		return {
			analysis: result,
			receipt: generated.receipt,
			repaired: generated.repaired,
		};
	} catch (error) {
		if (
			error instanceof Error &&
			error.message === "invalid_conversation_operation"
		)
			await recordRejected(
				deps,
				input.runId,
				decisionDraft(input, found.started, {
					route: found.route,
					query: found.query,
				}),
			);
		throw error;
	}
}
