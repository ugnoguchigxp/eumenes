import { getLogger } from "../../../infrastructure/logger";
import {
	SAID,
	answerQuestion,
	approveConfirmation,
	askBack,
	checkWork,
	declineConfirmation,
	handWith,
	instantWith,
	operateWork,
	readWith,
	requestMemory,
	type Step,
} from "./routed-actions";
import {
	choiceMessages,
	choiceSchema,
	pendingMessages,
	pendingSchema,
	type ChoiceCandidate,
	type parseChoice,
} from "./routed-choice";
import { shadowRoute } from "./routed-router";
import { searchTurn, styleOf } from "./routed-search";
import type { Turn } from "./routed-turn";

const log = getLogger("dialogue");

/** The pending turn's choices, as the log may name them (nothing the model wrote reaches the log). */
const PENDING_CHOICES = new Set(["none", "approve", "decline", "answer"]);
/** Choices one request turn may make: the first, and one more after a choice that could not be carried out. */
const CHOICE_ROUNDS = 2;

/** The request turn (section 4.3): the host searches with the user's words, then one choice (one more if it failed). */
export async function requestTurn(turn: Turn): Promise<Step> {
	const { utterance } = turn;
	const routed = turn.routed!;
	const asked = routed.asked;
	const words = asked ? `${asked.request}\n${utterance}` : utterance;
	const { candidates } = await searchTurn(turn, words);
	// The shadow router looks at the same turn beside the choice and changes nothing of it (spec §8, R1).
	const shadow =
		turn.router?.settings.mode === "shadow"
			? shadowRoute(turn, turn.router, words)
			: undefined;
	try {
		const style = styleOf(turn);
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
	} finally {
		await shadow;
	}
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
	if (choice === "ask") return askBack(turn, say);
	if (choice === "memory.request") return requestMemory(turn, chosen, say);
	if (/^t\d+$/.test(choice) && chosen.operation === "check")
		return checkWork(turn, choice);
	if (/^t\d+$/.test(choice))
		return operateWork(turn, choice, chosen.operation, chosen.text, say);
	const candidate = candidates.find((c) => c.id === choice);
	if (!candidate) return { retry: "choice_not_offered" };
	if (candidate.execution === "read")
		return readWith(turn, candidate, chosen.inputs);
	if (candidate.execution === "instant")
		return instantWith(turn, candidate, chosen.inputs);
	return handWith(turn, candidate, chosen, say, words);
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
	if (chosen.choice === "approve" && typeof chosen.confirmation === "string")
		return approveConfirmation(turn, chosen.confirmation);
	if (chosen.choice === "decline" && typeof chosen.confirmation === "string")
		return declineConfirmation(turn, chosen.confirmation);
	if (
		chosen.choice === "answer" &&
		typeof chosen.todo === "string" &&
		typeof chosen.text === "string"
	)
		return answerQuestion(turn, chosen.todo, chosen.text);
	return "talk";
}

/** A choice as the log names it: no words of the user's, only what kind of thing was chosen. */
function kindOfChoice(
	choice: string | undefined,
	candidates: readonly ChoiceCandidate[],
): string {
	if (!choice) return "unreadable";
	if (["none", "ask", "memory.request"].includes(choice)) return choice;
	if (/^t\d+$/.test(choice)) return "todo";
	const candidate = candidates.find((c) => c.id === choice);
	return candidate ? `toolchain_${candidate.execution ?? "work"}` : "unknown";
}
