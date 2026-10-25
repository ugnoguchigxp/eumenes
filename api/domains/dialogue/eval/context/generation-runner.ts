/**
 * Runs one prepared generation through the production loop (`runGeneration`: the conversation agent answers, using
 * the fixed tools when the conversation calls for them). The model is whatever `inference` is (the live LARM
 * connection, or the scripted model of the fixture lane); the host side of the tools is an offline stand-in that
 * keeps the rules the model must meet (a toolchain that was offered, an announcement with a delegation, a
 * confirmation before a change) by refusing a call that breaks them, as the product does, and changes nothing: no
 * TODO is made, nothing is executed.
 */
import { ValidationFailure } from "../../../../infrastructure/validation-log";
import type { InferencePort } from "../../../inference";
import type { DialogueDeps, GenerateInput } from "../../service/context";
import {
	type ToolExecutor,
	type ToolOutcome,
	runGeneration,
} from "../../service/generation-loop";
import { evalConversationAgent } from "./conversation-agent";
import { TOOL_NAMES, toolRejection } from "../../service/generation-tools";
import type { Answer, ToolCallRecord } from "./checks";
import type { EvalCard } from "./session";

export type ConversationCall = {
	caseId: string;
	trial: number;
	input: GenerateInput;
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
	todos: Array<{ id: string; revision: number; status: string }>;
	confirmations: string[];
	activeText: Map<string, string>;
};

/** What the tools need to know of the window the model read: the TODOs, the confirmations, the result slots. */
function viewOf(input: GenerateInput): DocumentView {
	const doc = JSON.parse(input.document.text) as {
		state?: {
			todos?: DocumentView["todos"];
			pendingConfirmation?: Array<{ id: string }>;
		};
		active?: Array<{ todo?: string }>;
	};
	return {
		todos: doc.state?.todos ?? [],
		confirmations: (doc.state?.pendingConfirmation ?? []).map((c) => c.id),
		activeText: new Map(
			(doc.active ?? []).flatMap((slot) =>
				slot.todo ? [[slot.todo, JSON.stringify(slot)] as const] : [],
			),
		),
	};
}

/** The offline host side of the fixed tools. `ended` is set when a delegation handed the work over. */
function createEvalExecutor(
	input: GenerateInput,
	catalog: readonly EvalCard[],
	record: ToolCallRecord[],
) {
	const view = viewOf(input);
	const offered = new Set(input.retained.map((entry) => entry.card.id));
	const state = { ended: false, announcement: "" };
	const need = (tool: string, path: string, reason: string) =>
		toolRejection(reason, [{ tool, path, reason }]);
	const execute: ToolExecutor = async (call) => {
		record.push({ name: call.name, arguments: call.call.arguments });
		switch (call.name) {
			case "memory":
				return call.args.operation === "read"
					? { result: { items: [] } }
					: { result: { accepted: true, requestId: "eval-memory-request" } };
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
					state.ended = true;
					state.announcement = args.announcement ?? "";
					return {
						result: { delegated: true, todo: "eval-todo" },
						end: true,
					};
				}
				if (!offered.has(args.toolchain))
					throw need(TOOL_NAMES.delegate, "toolchain", "toolchain_not_offered");
				if (!args.announcement)
					throw need(
						TOOL_NAMES.delegate,
						"announcement",
						"announcement_required",
					);
				if (args.mode === "confirm")
					return {
						result: { confirmation: "eval-confirmation", expiresAt: "eval" },
						confirmation: true,
					};
				if (args.impact === "modify_existing" || args.impact === "irreversible")
					throw need(TOOL_NAMES.delegate, "mode", "confirmation_required");
				state.ended = true;
				state.announcement = args.announcement;
				return {
					result: { delegated: true, todo: "eval-todo" },
					end: true,
				};
			}
			case "work": {
				const todo = view.todos.find((t) => t.id === call.args.todo);
				if (!todo) return { result: { ok: false, code: "todo_not_found" } };
				if (todo.revision !== call.args.revision)
					return { result: { ok: false, code: "revision_stale", todo } };
				const slot = view.activeText.get(todo.id);
				return {
					result: {
						ok: true,
						todo,
						...(call.args.operation === "check" && slot
							? { result: JSON.parse(slot) }
							: {}),
					},
				} satisfies ToolOutcome;
			}
		}
	};
	return { execute, state };
}

/**
 * The generation of `input` against `inference`, as the host would carry it out. Output that breaks the generation
 * contract (control text in the speech) is a `contract_failure` (a model result, scored as a failure); any other
 * error is the caller's transport error.
 */
export async function runConversation(options: {
	inference: Pick<InferencePort, "answer" | "executeStream">;
	input: GenerateInput;
	catalog: readonly EvalCard[];
	signal: AbortSignal;
}): Promise<ConversationOutcome> {
	const { input } = options;
	const record: ToolCallRecord[] = [];
	const { execute, state } = createEvalExecutor(input, options.catalog, record);
	const deps = {
		larm: options.inference,
		conversationAgent: evalConversationAgent,
	} as unknown as DialogueDeps;
	try {
		const generated = await runGeneration(deps, input, {
			signal: options.signal,
			delta: () => {},
			execute,
		});
		return {
			kind: "ok",
			// A delegation ended the generation: what the user hears is the announcement that went with it.
			text: generated.ended ? state.announcement : generated.text,
			toolCalls: record,
		};
	} catch (error) {
		if (error instanceof ValidationFailure)
			return { kind: "contract_failure", code: error.message };
		throw error;
	}
}

/** What the scoring reads of an outcome that ran. */
export const answerOf = (
	outcome: Extract<ConversationOutcome, { kind: "ok" }>,
): Answer => ({ text: outcome.text, toolCalls: outcome.toolCalls });
