import type { UtteranceToolCall } from "../../conversation";
import { TOOL_NAMES } from "./generation-tools";
import type { DocumentRefs } from "./work-items";

/**
 * The tools whose exchange a turn leaves in the recent conversation (the tool-call reliability design, P1): the
 * search and the hand-over. A later turn sees that a request was found and handed over, not only the announcement;
 * with the announcement alone the model answers the next request in words only, as it sees itself do.
 */
const CARRIED = new Set<string>([
	TOOL_NAMES.search,
	TOOL_NAMES.delegate,
	// A routed turn's question back: the next turn takes the user's answer with the request it asked about.
	"ask",
]);

/** The step a routed turn keeps when it asked back instead of choosing (the local harness rebuild plan, 4.3). */
export const ASK_STEP = "ask";

/** One call of a turn as it ran: the model's call and the host's result (`{ refused: true }` for a refused call). */
export type ExchangeStep = { name: string; arguments: string; result: unknown };

export const carriesExchange = (name: string) => CARRIED.has(name);

/** A carried argument string shows at most this many characters; the rest is cut with `…`. */
export const ARGUMENT_CHARS = 300;

const recordOf = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

/**
 * A result as later turns see it: the search's candidates by id, title, summary and execution; a hand-over by the
 * host's number and whether it was taken. An instant answer's text is not kept (its facts are not carried over).
 */
function carriedResult(
	name: string,
	result: unknown,
	refs: DocumentRefs,
): Record<string, unknown> {
	const record = recordOf(result);
	if (record.refused === true) return { refused: true };
	if (name === ASK_STEP) return {};
	if (name === TOOL_NAMES.search)
		return {
			candidates: (Array.isArray(record.candidates)
				? record.candidates
				: []
			).map((candidate) => {
				const c = recordOf(candidate);
				return {
					id: c.id,
					title: c.title,
					summary: c.summary,
					...(c.execution ? { execution: c.execution } : {}),
				};
			}),
		};
	if (typeof record.confirmation === "string")
		return { confirmation: record.confirmation };
	if (record.delegated === true) {
		const todo =
			typeof record.todo === "string" ? refs.todo(record.todo) : null;
		return todo ? { todo } : { delegated: true };
	}
	if (typeof record.answered === "boolean")
		return { answered: record.answered };
	return { delegated: false };
}

/**
 * A call's arguments as later turns replay them: always a JSON object (a call the host refused for its form may not
 * be one, and a provider rejects such a call in the history), each text within `ARGUMENT_CHARS`. The request of a
 * hand-over can be long; its head says what was asked.
 */
function carriedArguments(raw: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return "{}";
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		return "{}";
	const bounded = (value: unknown): unknown =>
		typeof value === "string"
			? value.length > ARGUMENT_CHARS
				? `${value.slice(0, ARGUMENT_CHARS)}…`
				: value
			: Array.isArray(value)
				? value.map(bounded)
				: value && typeof value === "object"
					? Object.fromEntries(
							Object.entries(value).map(([key, v]) => [key, bounded(v)]),
						)
					: value;
	return JSON.stringify(bounded(parsed));
}

/** The exchange of a turn to keep with the agent's utterance that ends it. */
export function carriedToolCalls(
	steps: readonly ExchangeStep[],
	refs: DocumentRefs,
): UtteranceToolCall[] {
	return steps
		.filter((step) => carriesExchange(step.name))
		.map((step) => ({
			name: step.name,
			arguments: carriedArguments(step.arguments),
			result: JSON.stringify(carriedResult(step.name, step.result, refs)),
		}));
}
