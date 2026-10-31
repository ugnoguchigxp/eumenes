/**
 * Runs one prepared generation through the product's routed turn (`runRoutedTurn`: the host routes the turn, then the
 * model talks or makes one choice held to a schema built from the turn's candidates). The model is whatever
 * `inference` is (the live LARM connection, or the scripted model of the fixture lane); the host side of the
 * operations (search, hand-over, confirmation, work, memory) is an offline stand-in that keeps the rules the choice
 * must meet (a toolchain that was offered, an announcement with a hand-over, a confirmation before a change of a saved
 * item) by refusing an operation that breaks them, as the product does, and changes nothing: no TODO is made, nothing
 * is executed. Without a judge connection the routing is `free`: every turn of utterances is a request turn.
 */
import type { InferencePort } from "../../../inference";
import type { DialogueDeps, GenerateInput } from "../../service/context";
import { TOOL_NAMES, toolRejection } from "../../service/generation-tools";
import {
	type RoutedTurnOptions,
	runRoutedTurn,
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

type DocumentView = {
	/** The work the choice calls read (`t<n>`), with the line `## State` shows for each. */
	todos: Array<{ id: string; line: string }>;
	/** The confirmation numbers the pending turn reads (`c<n>`). */
	confirmations: string[];
};

/** What the operations need to know of the input the choice calls read: the work and the open confirmations. */
function viewOf(input: GenerateInput): DocumentView {
	const routed = input.routed;
	const lines = (routed?.state ?? "").split("\n");
	return {
		todos: (routed?.todos ?? []).map((todo) => ({
			id: `t${todo.ref}`,
			line:
				lines.find((line) => line.startsWith(`- t${todo.ref} `))?.slice(2) ??
				todo.title,
		})),
		confirmations: (routed?.pending.confirmations ?? []).map(
			(c) => `c${c.ref}`,
		),
	};
}

/** The offline host side of the operations. `ended` is set when a hand-over ended the turn. */
function createEvalExecutor(
	input: GenerateInput,
	catalog: readonly EvalCard[],
	record: ToolCallRecord[],
) {
	const view = viewOf(input);
	const offered = new Set(input.retained.map((entry) => entry.card.id));
	const state = { announcement: "" };
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
				if (args.mode === "approve") {
					if (!view.confirmations.includes(args.confirmation))
						return {
							result: { delegated: false, code: "confirmation_unknown" },
						};
					state.announcement = args.announcement ?? "";
					return {
						result: { delegated: true, todo: "eval-todo" },
						end: true,
					};
				}
				if (!offered.has(args.toolchain))
					throw need(TOOL_NAMES.delegate, "toolchain", "toolchain_not_offered");
				if (args.mode === "confirm")
					return {
						result: { confirmation: "eval-confirmation", expiresAt: "eval" },
						confirmation: true,
					};
				// A request that names a saved item changes something that exists: it is confirmed first.
				if (args.target)
					throw need(TOOL_NAMES.delegate, "mode", "confirmation_required");
				state.announcement = args.announcement ?? "";
				return {
					result: { delegated: true, todo: "eval-todo" },
					end: true,
				};
			}
			case "work": {
				const todo = view.todos.find((t) => t.id === call.args.todo);
				if (!todo) return { result: { ok: false, code: "todo_not_found" } };
				// A check reads the record of the work; any other operation is taken.
				return call.args.operation === "check"
					? { result: todo.line }
					: { result: { ok: true, todo: todo.id } };
			}
			default:
				// The read tools find nothing in the evaluation's simulated host.
				return { result: { text: "" } };
		}
	};
	/** The user declines a confirmation: closed when it is one the input shows. */
	const decline = async (ref: number) => view.confirmations.includes(`c${ref}`);
	return { execute, decline, state };
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
	const { execute, decline, state } = createEvalExecutor(
		input,
		options.catalog,
		record,
	);
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
	const generated = await runRoutedTurn(deps, input, {
		signal: options.signal,
		delta: () => {},
		execute,
		decline,
	});
	return {
		kind: "ok",
		// A hand-over ended the turn: what the user hears is the announcement that went with it.
		text: generated.ended ? state.announcement : generated.text,
		toolCalls: record,
	};
}

/** What the scoring reads of an outcome that ran. */
export const answerOf = (
	outcome: Extract<ConversationOutcome, { kind: "ok" }>,
): Answer => ({ text: outcome.text, toolCalls: outcome.toolCalls });
