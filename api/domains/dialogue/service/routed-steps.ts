import { getLogger } from "../../../infrastructure/logger";
import { systemContext } from "../../../infrastructure/system-context";
import { personaStyle } from "./context-system";
import { IMPACT_ORDER, candidateOf } from "./executor-context";
import { sessionTargetsInTransaction } from "./specialist-context";
import { TOOL_NAMES } from "./generation-tools";
import { lineText } from "./input-text";
import { toolResultText } from "./result-text";
import {
	choiceMessages,
	choiceSchema,
	pendingMessages,
	pendingSchema,
	type ChoiceCandidate,
	type parseChoice,
} from "./routed-choice";
import type { Turn } from "./routed-turn";
import { ARGUMENT_CHARS, ASK_STEP } from "./tool-exchange";

const log = getLogger("dialogue");

/** The words the host says itself (the local harness rebuild plan, sections 4.3 and 4.4). */
const SAID = {
	failed: systemContext("dialogue.contexts.local.failed", {}),
	approved: systemContext("dialogue.contexts.local.approved", {}),
	declined: systemContext("dialogue.contexts.local.declined", {}),
	answered: systemContext("dialogue.contexts.local.answered", {}),
	recalled: systemContext("dialogue.contexts.local.recalled", {}),
	notRecalled: systemContext("dialogue.contexts.local.not-recalled", {}),
	checked: systemContext("dialogue.contexts.local.checked", {}),
};
const IMPACT_SAID: Record<string, string> = {
	modify_existing: systemContext("dialogue.contexts.local.impact-modify", {}),
	irreversible: systemContext(
		"dialogue.contexts.local.impact-irreversible",
		{},
	),
};
/** The pending turn's choices, as the log may name them (nothing the model wrote reaches the log). */
const PENDING_CHOICES = new Set(["none", "approve", "decline", "answer"]);
/** The request a confirmation statement quotes, at most. */
const CONFIRM_REQUEST_CHARS = 80;
/** The longest query the toolchain search takes (`find_toolchain`'s bound). */
const SEARCH_QUERY_CHARS = 2000;
/** Choices one request turn may make: the first, and one more after a choice that could not be carried out. */
const CHOICE_ROUNDS = 2;

/** How a step of the turn ended: it said what it had to, the talk turn answers, or the choice is made again. */
export type Step = "done" | "talk" | { retry: string; exclude?: string };

/** The request turn (section 4.3): the host searches with the user's words, then one choice (one more if it failed). */
export async function requestTurn(turn: Turn): Promise<Step> {
	const { deps, input, utterance } = turn;
	const routed = turn.routed!;
	const asked = routed.asked;
	const words = asked ? `${asked.request}\n${utterance}` : utterance;
	// The search reads the head of long words (its query has a bound).
	const found = await turn.act(TOOL_NAMES.search, {
		query: words.trim().slice(0, SEARCH_QUERY_CHARS),
	});
	const shown =
		"outcome" in found
			? ((found.outcome.result as { candidates?: ChoiceCandidate[] })
					.candidates ?? [])
			: [];
	// The toolchains of the work in progress stay choosable though this search did not find them.
	const candidates: ChoiceCandidate[] = [
		...shown,
		...input.retained
			.filter((entry) => !shown.some((c) => c.id === entry.card.id))
			.map((entry) =>
				candidateOf(
					entry.card,
					// What its session works on stays its target (a change of it is confirmed).
					deps.store.read((tx) =>
						sessionTargetsInTransaction(deps, tx, entry.card, input.runId),
					),
				),
			),
	];
	const style = deps.store.read((tx) =>
		personaStyle(
			deps.larm.snapshotInTransaction?.(tx).general ?? {
				agentName: "",
				userName: "",
				persona: "butler",
			},
		),
	);
	const excluded = new Set<string>();
	let retry: string | undefined;
	for (let round = 0; round < CHOICE_ROUNDS; round++) {
		const chosen = await turn.choose(
			choiceMessages({
				style,
				routed,
				candidates,
				utterance,
				excluded,
				...(retry ? { retry } : {}),
			}),
			choiceSchema(candidates, routed, excluded),
		);
		log.info("dialogue.choice_made", {
			kind: "request",
			decision:
				chosen === "cut" ? "cut" : kindOfChoice(chosen?.choice, candidates),
			attempt: round + 1,
		});
		// No choice was completed at the output limit: the talk turn answers without a retry.
		if (chosen === "cut") return "talk";
		const step = await carryOut(turn, chosen, candidates, words);
		if (typeof step === "string") return step;
		retry = step.retry;
		if (step.exclude) excluded.add(step.exclude);
	}
	turn.speak(SAID.failed);
	return "done";
}

/** What one choice of the request turn does (section 4.3). */
async function carryOut(
	turn: Turn,
	chosen: ReturnType<typeof parseChoice>,
	candidates: readonly ChoiceCandidate[],
	/** The user's words the turn acts on (with the request it asked back about). */
	words: string,
): Promise<Step> {
	// An answer that is no choice at all: making it again on the same input would read the same, so the talk turn
	// answers (a refused choice is the one made again).
	if (!chosen) return "talk";
	const say = typeof chosen.say === "string" ? chosen.say : "";
	const choice = chosen.choice;
	if (choice === "none") return "talk";
	if (choice === "ask") {
		turn.speak(say);
		turn.exchange.push({
			name: ASK_STEP,
			arguments: JSON.stringify({
				request: askedRequest(turn.routed?.asked?.request, turn.utterance),
			}),
			result: {},
		});
		return "done";
	}
	if (choice === "memory.recall") {
		const read = await turn.act(TOOL_NAMES.memory, {
			operation: "read",
			query: chosen.query,
		});
		if ("refused" in read) return { retry: turn.reasonOf(read.refused) };
		const items = (read.outcome.result as { items?: unknown[] }).items ?? [];
		await turn.talk(
			items.length
				? `${SAID.recalled}\n${toolResultText(TOOL_NAMES.memory, read.outcome.result)}`
				: SAID.notRecalled,
		);
		return "done";
	}
	if (choice === "memory.request") {
		const asked = await turn.act(TOOL_NAMES.memory, {
			operation: "request",
			kind: chosen.kind,
			what: chosen.what,
			...(typeof chosen.detail === "string" ? { detail: chosen.detail } : {}),
		});
		if ("refused" in asked) return { retry: turn.reasonOf(asked.refused) };
		const accepted = (asked.outcome.result as { accepted?: unknown }).accepted;
		turn.speak(accepted === true ? say : SAID.failed);
		return "done";
	}
	if (/^t\d+$/.test(choice) && chosen.operation === "check") {
		// A check only reads the work's record; the talk turn tells it (what it read is what the reply may report).
		const read = await turn.act(TOOL_NAMES.work, {
			todo: choice,
			operation: "check",
		});
		if ("refused" in read) return { retry: turn.reasonOf(read.refused) };
		const result = read.outcome.result;
		if (typeof result !== "string")
			return {
				retry: String((result as { code?: unknown }).code ?? "todo_not_found"),
			};
		await turn.talk(`${SAID.checked}\n${result}`);
		return "done";
	}
	if (/^t\d+$/.test(choice)) {
		const worked = await turn.act(TOOL_NAMES.work, {
			todo: choice,
			operation: chosen.operation,
			...(typeof chosen.text === "string" ? { text: chosen.text } : {}),
		});
		if ("refused" in worked) return { retry: turn.reasonOf(worked.refused) };
		const ok = (worked.outcome.result as { ok?: unknown }).ok;
		turn.speak(ok === false ? SAID.failed : say);
		return "done";
	}
	const candidate = candidates.find((c) => c.id === choice);
	if (!candidate) return { retry: "choice_not_offered" };
	if (candidate.execution === "instant") {
		const answered = await turn.act(TOOL_NAMES.delegate, {
			mode: "execute",
			toolchain: candidate.id,
			impact: "none",
			inputs: chosen.inputs ?? {},
		});
		if ("refused" in answered)
			return { retry: turn.reasonOf(answered.refused) };
		const result = answered.outcome.result as {
			answered?: unknown;
			answer?: unknown;
			code?: unknown;
		};
		if (result.answered === true && typeof result.answer === "string") {
			turn.speak(result.answer);
			return "done";
		}
		// The toolchain could not answer: another candidate may (its own description names which).
		return {
			retry: `${candidate.title}: ${String(result.code ?? "no_answer")}`,
			exclude: candidate.id,
		};
	}
	const request = {
		toolchain: candidate.id,
		announcement: say,
		// A pipeline's branch has no request text: the user's words are what its inputs quote.
		request: typeof chosen.request === "string" ? chosen.request : words,
		...(typeof chosen.target === "string" ? { target: chosen.target } : {}),
		...(Array.isArray(chosen.refs) && chosen.refs.length
			? { refs: chosen.refs }
			: {}),
		...(candidate.execution === "pipeline" && chosen.inputs
			? { inputs: chosen.inputs }
			: {}),
	};
	const handed = await turn.act(TOOL_NAMES.delegate, {
		mode: "execute",
		...request,
	});
	if ("refused" in handed) {
		if (handed.refused.message !== "confirmation_required")
			return { retry: turn.reasonOf(handed.refused) };
		// A change of something that exists, or one that cannot be undone, is confirmed first (section 6.7).
		const issued = await turn.act(TOOL_NAMES.delegate, {
			mode: "confirm",
			...request,
		});
		if ("refused" in issued) return { retry: turn.reasonOf(issued.refused) };
		if (!issued.outcome.confirmation)
			return {
				retry: String(
					(issued.outcome.result as { code?: unknown }).code ??
						"confirmation_failed",
				),
			};
		turn.speak(confirmStatement(candidate, request));
		return "done";
	}
	if (handed.outcome.end) return "done";
	const code = (handed.outcome.result as { code?: unknown }).code;
	return {
		retry: `${candidate.title}: ${String(code ?? "not_delegated")}`,
		exclude: candidate.id,
	};
}

/**
 * The whole request so far for the ask step, within what a carried call keeps (no cut mark on it): after a question
 * asked before, the head of its request and the newest words, the newest kept whole while both do not fit.
 */
export function askedRequest(before: string | undefined, utterance: string) {
	if (!before) return utterance.slice(0, ARGUMENT_CHARS);
	const newest = utterance.slice(
		0,
		Math.max(ARGUMENT_CHARS / 2, ARGUMENT_CHARS - before.length - 1),
	);
	return `${before.slice(0, ARGUMENT_CHARS - newest.length - 1)}\n${newest}`;
}

/** The pending turn (section 4.4): is the user answering a confirmation or a work's question? */
export async function pendingTurn(turn: Turn): Promise<Step> {
	const routed = turn.routed!;
	const answer = await turn.choose(
		pendingMessages(routed, turn.utterance),
		pendingSchema(routed.pending),
	);
	// An answer cut at the limit says nothing sure about the open items: the turn goes on as if none was answered.
	const chosen = answer === "cut" ? null : answer;
	log.info("dialogue.choice_made", {
		kind: "pending",
		decision:
			answer === "cut"
				? "cut"
				: !chosen
					? "unreadable"
					: PENDING_CHOICES.has(chosen.choice)
						? chosen.choice
						: "unknown",
	});
	if (!chosen || chosen.choice === "none") return "talk";
	if (chosen.choice === "approve" && typeof chosen.confirmation === "string") {
		const approved = await turn.act(TOOL_NAMES.delegate, {
			mode: "approve",
			confirmation: chosen.confirmation,
			announcement: SAID.approved,
		});
		if (!("outcome" in approved) || !approved.outcome.end)
			turn.speak(SAID.failed);
		return "done";
	}
	if (chosen.choice === "decline" && typeof chosen.confirmation === "string") {
		const closed = await turn.decline(Number(chosen.confirmation.slice(1)));
		turn.speak(closed ? SAID.declined : SAID.failed);
		return "done";
	}
	if (
		chosen.choice === "answer" &&
		typeof chosen.todo === "string" &&
		typeof chosen.text === "string"
	) {
		const worked = await turn.act(TOOL_NAMES.work, {
			todo: chosen.todo,
			operation: "answer",
			text: chosen.text,
		});
		if (
			!("outcome" in worked) ||
			(worked.outcome.result as { ok?: unknown }).ok === false
		)
			turn.speak(SAID.failed);
		// A command's question resumes its work under this run (a hand-over): nothing is said now, the work's report is
		// the run's answer. A task takes the answer in its own control, and the host tells it was passed on.
		else if (worked.outcome.end !== true) turn.speak(SAID.answered);
		return "done";
	}
	return "talk";
}

/** A choice as the log names it: no words of the user's, only what kind of thing was chosen. */
function kindOfChoice(
	choice: string | undefined,
	candidates: readonly ChoiceCandidate[],
): string {
	if (!choice) return "unreadable";
	if (["none", "ask", "memory.recall", "memory.request"].includes(choice))
		return choice;
	if (/^t\d+$/.test(choice)) return "todo";
	const candidate = candidates.find((c) => c.id === choice);
	return candidate ? `toolchain_${candidate.execution ?? "work"}` : "unknown";
}

/** The host's confirmation statement: the toolchain, the request and what it does to what exists (section 6.7). */
function confirmStatement(
	candidate: ChoiceCandidate,
	request: { request?: string; target?: string },
): string {
	const declared = request.target ? "modify_existing" : "none";
	const impact =
		IMPACT_ORDER[
			Math.max(
				IMPACT_ORDER.indexOf(declared),
				candidate.minImpact
					? IMPACT_ORDER.indexOf(
							candidate.minImpact as (typeof IMPACT_ORDER)[number],
						)
					: 0,
			)
		]!;
	const words = {
		title: lineText(candidate.title),
		request: lineText(request.request ?? "").slice(0, CONFIRM_REQUEST_CHARS),
		impact: IMPACT_SAID[impact] ?? IMPACT_SAID.modify_existing!,
	};
	// The item it changes is named as the candidate showed it: the user approves that item, not any.
	const target = candidate.targets?.find((t) => t.ref === request.target);
	return target
		? systemContext("dialogue.contexts.local.confirm-target", {
				...words,
				target: lineText(target.label),
			})
		: systemContext("dialogue.contexts.local.confirm", words);
}
