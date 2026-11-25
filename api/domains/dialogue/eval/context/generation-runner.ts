/**
 * Runs one prepared generation through `runConversationTurn` with the fixture or live inference port.
 * The evaluation substitutes read-only host operations for the application's execution ports.
 */
import type { InferencePort } from "../../../inference";
import type { DialogueDeps, GenerateInput } from "../../service/context";
import { TOOL_NAMES, toolRejection } from "../../service/generation-tools";
import {
	type RoutedTurnOptions,
	runConversationTurn,
} from "../../service/routed-turn";
import { evalConversationAgent } from "./conversation-agent";
import type { Answer, ToolCallRecord } from "./checks";
import type { EvalCard, Persona } from "./session";

type ToolExecutor = RoutedTurnOptions["execute"];

export type ConversationCall = {
	caseId: string;
	trial: number;
	input: GenerateInput;
	/** The persona the case sets: the choice call writes its `say` in its style. */
	persona: Persona;
};
export type ConversationOutcome =
	| { kind: "ok"; text: string; toolCalls: ToolCallRecord[] }
	| { kind: "contract_failure"; code: string };
/** Performs one conversation call. A thrown error is a transport error. */
export type ConversationRunner = (
	call: ConversationCall,
	signal: AbortSignal,
) => Promise<ConversationOutcome>;

/** The search results the offline host returns at most (section 6.1). */
const CANDIDATES = 4;

const bigrams = (text: string) => {
	const chars = [...text.normalize("NFKC").toLowerCase().replace(/\s+/g, "")];
	const grams = new Set<string>();
	for (let i = 0; i + 2 <= chars.length; i++)
		grams.add(chars.slice(i, i + 2).join(""));
	return grams;
};

/** The catalog entries closest to a query by shared character pairs (no embeddings offline), best first. */
export function rankCandidates(
	catalog: readonly EvalCard[],
	query: string,
): EvalCard[] {
	const wanted = bigrams(query);
	return catalog
		.map((card, index) => {
			const have = bigrams(
				[card.title, card.summary, ...card.useWhen].join(" "),
			);
			let common = 0;
			for (const gram of wanted) if (have.has(gram)) common++;
			return { card, index, common };
		})
		.sort((a, b) => b.common - a.common || a.index - b.index)
		.slice(0, CANDIDATES)
		.map((entry) => entry.card);
}

/** The offline host side of the operations: a delegation is the agent's assignment, accepted as it is asked. */
function createEvalExecutor(
	input: GenerateInput,
	catalog: readonly EvalCard[],
	record: ToolCallRecord[],
) {
	const offered = new Set(input.switching ? [input.switching.id] : []);
	const need = (tool: string, path: string, reason: string) =>
		toolRejection(reason, [{ tool, path, reason }]);
	const execute: ToolExecutor = async (call) => {
		record.push({ name: call.name, arguments: call.call.arguments });
		switch (call.name) {
			case "memory":
				return { result: { accepted: true, requestId: "eval-memory-request" } };
			case "find_toolchain": {
				const found = rankCandidates(catalog, call.args.query);
				for (const card of found) offered.add(card.id);
				return {
					result: {
						candidates: found.map((card) => ({
							id: card.id,
							title: card.title,
							summary: card.summary,
							useWhen: card.useWhen,
						})),
					},
				};
			}
			case "delegate": {
				const args = call.args;
				if (!offered.has(args.toolchain))
					throw need(TOOL_NAMES.delegate, "toolchain", "toolchain_not_offered");
				return {
					result: {
						delegated: true,
						assignment: "eval-assignment",
						assignee: args.toolchain,
					},
				};
			}
			default:
				// The read tools find nothing in the evaluation's simulated host.
				return { result: { text: "" } };
		}
	};
	return { execute };
}

/**
 * The turn of `input` against `inference`, as the host would carry it out. A call that fails on its output is the
 * turn's own: the host says its fixed words, as in the product. Any other error is the caller's transport error.
 */
export async function runConversation(options: {
	inference: Pick<InferencePort, "answer" | "executeStream">;
	input: GenerateInput;
	catalog: readonly EvalCard[];
	persona: Persona;
	signal: AbortSignal;
}): Promise<ConversationOutcome> {
	const { input, inference } = options;
	const record: ToolCallRecord[] = [];
	const { execute } = createEvalExecutor(input, options.catalog, record);
	// Only the ports the routed turn reads: the model, the persona the choice writes in, and the reply loop. The
	// store is read for the persona alone, which the case decides.
	const deps = {
		store: { read: <T>(read: (tx: never) => T) => read(undefined as never) },
		larm: {
			answer: inference.answer,
			executeStream: inference.executeStream,
			snapshotInTransaction: () => ({ general: options.persona }),
		},
		conversationAgent: evalConversationAgent,
	} as unknown as DialogueDeps;
	const generated = await runConversationTurn(deps, input, {
		signal: options.signal,
		delta: () => {},
		execute,
	});
	return { kind: "ok", text: generated.text, toolCalls: record };
}

/** What the scoring reads of an outcome that ran. */
export const answerOf = (
	outcome: Extract<ConversationOutcome, { kind: "ok" }>,
): Answer => ({ text: outcome.text, toolCalls: outcome.toolCalls });
