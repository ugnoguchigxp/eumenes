import { systemContext } from "../../../infrastructure/system-context";
import type { AgentToolDefinition } from "../contracts";
import { TOOL_NAMES } from "./generation-tools";
import { lineText } from "./input-text";
import { handWith, type Fields } from "./routed-actions";
import type { ChoiceCandidate } from "./routed-choice";
import { offerSources } from "./conversation-offers";
import { retainedChoice } from "./routed-search";
import { fieldsOf } from "./routed-fields";
import { createWorkControls } from "./talk-work-controls";
import type { Turn } from "./routed-turn";
import { ASK_STEP } from "./tool-exchange";

/** The resources `## State` presents that go with a request, at most. */
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
				toolchain: { type: "string", description: "宛先候補ID" },
				request: {
					type: "string",
					minLength: 1,
					maxLength: REQUEST_CHARS,
					description: "担当への作業指示全文",
				},
				revises: { type: "string", description: "訂正元の確認 c<n>" },
				diagnosticRef: { type: "string", description: "該当診断参照 e<n>" },
				// The agent's rules name these two; the host decides both itself.
				mode: { type: "string", enum: ["execute"] },
				impact: { type: "string" },
			},
		},
	},
];

type Answer = { content: string; end?: boolean };

const answer = (value: Record<string, unknown>, end = false): Answer => ({
	content: JSON.stringify(value),
	...(end ? { end: true } : {}),
});

/** The talk turn's hand-over tools for one reply: `delegate` takes a toolchain this conversation has been offered. */
export function createTalkWork(turn: Turn) {
	const found = new Map<string, ChoiceCandidate>(
		turn.input.offers?.map(({ card }) => [card.id, retainedChoice(turn, card)]),
	);
	let revisionUnderCorrection: number | undefined;
	const controls = createWorkControls(turn);
	const tools = [...TALK_WORK_TOOLS, ...controls.tools];

	async function find(args: Record<string, unknown>): Promise<Answer> {
		const query = typeof args.query === "string" ? args.query.trim() : "";
		if (!query || query.length > QUERY_CHARS)
			return answer({ candidates: [], code: "invalid_arguments" });
		const searched = await turn.act(TOOL_NAMES.search, {
			query,
		});
		if ("refused" in searched)
			return answer({ candidates: [], code: searched.refused.message });
		const result = searched.outcome.result as {
			candidates?: Array<ChoiceCandidate & { produces?: readonly string[] }>;
			code?: unknown;
		};
		found.clear();
		const shown: Record<string, unknown>[] = [];
		for (const card of searched.outcome.search?.cards ?? []) {
			if (card.read) continue;
			const choice = result.candidates?.find((c) => c.id === card.id);
			if (!choice) continue;
			found.set(card.id, choice);
			shown.push({
				id: card.id,
				title: card.title,
				summary: card.summary,
				useWhen: card.useWhen,
				execution: choice.execution,
				minImpact: choice.minImpact,
				...(choice.produces?.length ? { produces: choice.produces } : {}),
			});
		}
		// Later turns see of this search what the reply saw.
		const kept = turn.exchange.at(-1);
		if (kept?.name === TOOL_NAMES.search)
			kept.result = {
				sources: turn.deps.store.read((db) =>
					offerSources(
						turn.deps,
						db,
						turn.input.final.kind === "utterances"
							? turn.input.final.messageIds
							: [],
					),
				),
				candidates: shown.map((c) => ({
					...c,
					revisionId: searched.outcome.search!.cards.find(
						(card) => card.id === c.id,
					)!.revisionId,
				})),
				...(typeof result.code === "string" ? { code: result.code } : {}),
			};
		return answer({
			candidates: shown,
			...(!shown.length
				? {
						code:
							typeof result.code === "string" ? result.code : "no_candidate",
					}
				: {}),
		});
	}

	async function delegate(args: Record<string, unknown>): Promise<Answer> {
		const request = typeof args.request === "string" ? args.request.trim() : "";
		let revision = revisionUnderCorrection;
		if (args.revises !== undefined) {
			const item = [
				...turn.routed!.pending.confirmations,
				...(turn.routed!.pending.revisions ?? []),
			].find((c) => `c${c.ref}` === args.revises);
			if (!item || !(await turn.decline(item.ref, true)))
				return answer({ delegated: false, code: "revision_not_open" });
			revision = item.ref;
			revisionUnderCorrection = revision;
		}
		if (!request || request.length > REQUEST_CHARS)
			return answer({
				delegated: false,
				code: "invalid_arguments",
				field: "request",
				...(revision ? { revises: `c${revision}` } : {}),
			});
		if (typeof args.toolchain !== "string")
			return answer({
				delegated: false,
				code: "invalid_arguments",
				field: "toolchain",
			});
		const choice = found.get(args.toolchain);
		if (!choice) return answer({ delegated: false, code: "unknown_toolchain" });
		// The reply owns the request. The fill supplies arguments specific to the selected toolchain.
		const said = turn.said();
		const filled = await fieldsOf(
			turn,
			request,
			choice,
			request,
			typeof args.diagnosticRef === "string",
		);
		if ("step" in filled) {
			if (filled.step !== "done")
				return answer({ delegated: false, code: "request_unclear" });
			// The host asks and records the request so the next conversation turn can use the reply.
			if (turn.said() !== said) return answer({ asked: true }, true);
			if (turn.exchange.at(-1)?.name === ASK_STEP) turn.exchange.pop();
			return answer({ delegated: false, code: "request_unclear" });
		}
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
			if (revision && result.answered === true) await turn.decline(revision);
			return result.answered === true && typeof result.answer === "string"
				? answer({ answered: true, answer: result.answer })
				: answer({
						answered: false,
						code: typeof result.code === "string" ? result.code : "no_answer",
					});
		}
		const resources = turn.routed!.resources.slice(0, RESOURCE_REFS);
		// The pending-switch control is the only path here that can request discard of unsaved work.
		const { resolveUnsaved: _unsaved, ...given } = filled.fields;
		const fields: Fields = {
			...(revision ? { revises: revision } : {}),
			...(resources.length ? { refs: resources } : {}),
			...given,
			...(typeof args.diagnosticRef === "string"
				? { diagnosticRef: args.diagnosticRef }
				: {}),
			request,
			words: lineText(request).slice(0, TITLE_CHARS),
		};
		const before = turn.executed.length;
		const step = await handWith(
			turn,
			choice,
			fields,
			systemContext("dialogue.contexts.local.router-announce", {
				title: lineText(choice.title).slice(0, 30),
			}),
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
					call.name === TOOL_NAMES.delegate && outcome.confirmationId,
			);
		return answer(
			confirmed ? { confirmation: true } : { delegated: true },
			true,
		);
	}

	return {
		tools,
		handles: (name: string) => tools.some((tool) => tool.name === name),
		call(name: string, args: Record<string, unknown>) {
			if (name === TOOL_NAMES.search) return find(args);
			if (name === TOOL_NAMES.delegate) return delegate(args);
			return controls.call(name, args);
		},
	};
}
