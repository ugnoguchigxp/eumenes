import { systemContext } from "../../../infrastructure/system-context";
import type { AgentToolDefinition } from "../contracts";
import { TOOL_NAMES } from "./generation-tools";
import { lineText } from "./input-text";
import { handWith, type Fields } from "./routed-actions";
import type { ChoiceCandidate } from "./routed-choice";
import { fieldsOf } from "./routed-fields";
import type { RouteCandidate } from "./routed-route";
import { announcement, titleOf } from "./routed-router";
import type { Turn } from "./routed-turn";
import { ASK_STEP } from "./tool-exchange";

/**
 * The talk turn's way to a toolchain (spec router-package-integration, 2026-11-12): when the router left the turn to
 * the conversation, the reply itself may look for a toolchain and hand it the work. Looking is the host's search;
 * handing over runs the router's own hand-over (the same fields fill, the same host operations, the host's
 * announcement), so a request reaches a toolchain by one code path whoever chose it.
 */

/** The resources `## State` presents that go with a request, at most (as the router's hand-over). */
const RESOURCE_REFS = 8;
/** What a search's query and a hand-over's request keep of the reply's words. */
const QUERY_CHARS = 2000;
const REQUEST_CHARS = 8000;
/** The TODO's title, taken from the request the reply wrote (`## State` shows it in every later turn). */
const TITLE_CHARS = 120;

/** The reply's two tools; what they do is the host's text, when to use them the agent's rules. */
export const TALK_WORK_TOOLS: readonly AgentToolDefinition[] = [
	{
		name: TOOL_NAMES.search,
		description: systemContext("dialogue.contexts.local.talk-find", {}),
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["query"],
			properties: { query: { type: "string" } },
		},
	},
	{
		name: TOOL_NAMES.delegate,
		description: systemContext("dialogue.contexts.local.talk-delegate", {}),
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["toolchain", "request"],
			properties: {
				toolchain: { type: "string" },
				request: { type: "string" },
				// The agent's rules name these two; the host decides both itself.
				mode: { type: "string", enum: ["execute"] },
				impact: { type: "string" },
			},
		},
	},
];

type Found = Extract<RouteCandidate, { kind: "toolchain" }>;
type Answer = { content: string; end?: boolean };

const answer = (value: Record<string, unknown>, end = false): Answer => ({
	content: JSON.stringify(value),
	...(end ? { end: true } : {}),
});

/** The talk turn's hand-over tools for one reply: `delegate` takes only a toolchain this reply found. */
export function createTalkWork(turn: Turn) {
	const found = new Map<string, Found>();

	async function find(args: Record<string, unknown>): Promise<Answer> {
		const query = typeof args.query === "string" ? args.query.trim() : "";
		if (!query) return answer({ candidates: [], code: "invalid_arguments" });
		const searched = await turn.act(TOOL_NAMES.search, {
			query: query.slice(0, QUERY_CHARS),
		});
		if ("refused" in searched)
			return answer({ candidates: [], code: searched.refused.message });
		const result = searched.outcome.result as {
			candidates?: Array<ChoiceCandidate & { produces?: readonly string[] }>;
			code?: unknown;
		};
		const shown: Record<string, unknown>[] = [];
		for (const card of searched.outcome.search?.cards ?? []) {
			// The reply has the read tools itself, and a pipeline is the router's to plan.
			if (card.read || card.execution === "pipeline") continue;
			const choice = result.candidates?.find((c) => c.id === card.id);
			if (!choice) continue;
			found.set(card.id, {
				id: card.id,
				kind: "toolchain",
				passage: card.summary,
				card,
				choice,
			});
			shown.push({
				id: card.id,
				title: card.title,
				summary: card.summary,
				useWhen: card.useWhen,
				...(choice.produces?.length ? { produces: choice.produces } : {}),
			});
		}
		// Later turns see of this search what the reply saw.
		const kept = turn.exchange.at(-1);
		if (kept?.name === TOOL_NAMES.search)
			kept.result = {
				candidates: (result.candidates ?? []).filter((c) =>
					shown.some((s) => s.id === c.id),
				),
				...(typeof result.code === "string" ? { code: result.code } : {}),
			};
		return answer({
			candidates: shown,
			...(typeof result.code === "string" ? { code: result.code } : {}),
		});
	}

	async function delegate(args: Record<string, unknown>): Promise<Answer> {
		const request =
			typeof args.request === "string"
				? args.request.trim().slice(0, REQUEST_CHARS)
				: "";
		if (!request || typeof args.toolchain !== "string")
			return answer({ delegated: false, code: "invalid_arguments" });
		const c = found.get(args.toolchain);
		if (!c) return answer({ delegated: false, code: "unknown_toolchain" });
		// The reply wrote the request; what the toolchain takes besides it is filled as for the router's hand-over.
		const said = turn.said();
		const filled = await fieldsOf(turn, request, c, request);
		if ("step" in filled) {
			if (filled.step !== "done")
				return answer({ delegated: false, code: "request_unclear" });
			// The fill asked the user back: the host said the question, and the next turn's router takes the answer
			// with the request the reply wrote. A question with no words asked nothing.
			if (turn.said() !== said) return answer({ asked: true }, true);
			if (turn.exchange.at(-1)?.name === ASK_STEP) turn.exchange.pop();
			return answer({ delegated: false, code: "request_unclear" });
		}
		const { choice } = c;
		if (choice.execution === "instant") {
			const answered = await turn.act(TOOL_NAMES.delegate, {
				mode: "execute",
				toolchain: choice.id,
				impact: "none",
				inputs: filled.fields.inputs ?? {},
			});
			if ("refused" in answered)
				return answer({
					answered: false,
					code: turn.reasonOf(answered.refused),
				});
			const result = answered.outcome.result as {
				answered?: unknown;
				answer?: unknown;
				code?: unknown;
			};
			// The reply tells the answer in its own words (a read's result does the same).
			return result.answered === true && typeof result.answer === "string"
				? answer({ answered: true, answer: result.answer })
				: answer({
						answered: false,
						code: typeof result.code === "string" ? result.code : "no_answer",
					});
		}
		const resources = turn.routed!.resources.slice(0, RESOURCE_REFS);
		// Unsaved work goes only on the user's own word (the router's `switch.discard`), never on what the reply wrote.
		const { resolveUnsaved: _unsaved, ...given } = filled.fields;
		const fields: Fields = {
			...(resources.length ? { refs: resources } : {}),
			...given,
			request: typeof given.request === "string" ? given.request : request,
			// The user's own words may be a bare yes: the TODO is titled by the request the reply wrote.
			words: lineText(request).slice(0, TITLE_CHARS),
		};
		const before = turn.executed.length;
		const step = await handWith(
			turn,
			choice,
			fields,
			announcement("fixed", titleOf(c)),
			request,
		);
		if (step !== "done")
			return answer({
				delegated: false,
				code: typeof step === "object" ? step.retry : "not_delegated",
			});
		// Handed over (the host's announcement is the run's answer), or the host stated a confirmation: the reply ends.
		const confirmed = turn.executed
			.slice(before)
			.some(
				({ call, outcome }) =>
					call.name === TOOL_NAMES.delegate && outcome.confirmation,
			);
		return answer(
			confirmed ? { confirmation: true } : { delegated: true },
			true,
		);
	}

	return {
		tools: TALK_WORK_TOOLS,
		handles: (name: string) =>
			name === TOOL_NAMES.search || name === TOOL_NAMES.delegate,
		call: (name: string, args: Record<string, unknown>) =>
			name === TOOL_NAMES.search ? find(args) : delegate(args),
	};
}
