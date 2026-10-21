import { validRetainedSources } from "./retained-toolchains";
import { z } from "zod";
import type { Receipt } from "../../inference";
import { getLogger } from "../../../infrastructure/logger";
import type { DialogueDeps, GenerateInput } from "./context";
import type { ConversationOperation } from "./conversation-tools";
import type { FirstRound } from "./initial-decision";
import { currentRequestMessage } from "./request-context";
import { decisionDraft, type Candidates } from "./selection-trace";

const log = getLogger("dialogue");

/** What an instant toolchain's adapter may hand back as the answer: one spoken-length sentence or two. */
const instantAnswer = z.string().trim().min(1).max(600);
/** The most a toolchain request holds (the one-argument contract of `toolchainRequest`). */
const REQUEST_MAX_CHARS = 8000;

/**
 * The hand-over of a request the first round gave to an instant-answer toolchain: no notice, no second round.
 * The adapter's sentence is the answer, adopted as the host's own (no model wrote it). When the adapter cannot
 * answer, the request goes on in the same run to the toolchain its binding names, as the user said it.
 */
export async function answerInstant(
	deps: DialogueDeps,
	input: GenerateInput,
	handover: {
		found: Candidates;
		analysis: FirstRound & { next: "instant" };
		first: { receipt?: Receipt; repaired: boolean };
		signal: AbortSignal;
	},
) {
	const { found, analysis, first, signal } = handover;
	const { card } = analysis;
	const draft = decisionDraft(input, found.started, {
		analysis,
		route: found.route,
		query: found.query,
	});
	const prepared = deps.store.read((db) => {
		if (!validRetainedSources(deps, db, input))
			throw new Error("toolchain_context_stale");
		deps.toolchains?.resolveInTransaction(db, card.revisionId);
		return deps.toolchains?.instantInTransaction?.(db, card.revisionId);
	});
	if (!prepared) throw new Error("toolchain_unavailable");
	const started = Date.now();
	const result = await prepared.run(analysis.arguments, signal);
	signal.throwIfAborted();
	const answer = result.ok ? instantAnswer.safeParse(result.answer) : undefined;
	if (answer?.success) {
		log.info("dialogue.instant_answered", {
			toolchainId: card.id,
			durationMs: Date.now() - started,
		});
		return {
			text: answer.data,
			hostAnswer: true as const,
			selection: draft("toolchain", {
				toolchainId: card.id,
				toolchainRevisionId: card.revisionId,
				functionName: card.functionName,
				request: JSON.stringify(analysis.arguments),
				repaired: first.repaired,
			}),
			recallPins: [],
		};
	}
	log.warn("dialogue.instant_failed", {
		toolchainId: card.id,
		reason: result.ok ? "answer_invalid" : result.code,
		durationMs: Date.now() - started,
	});
	const { fallback } = prepared;
	if (!fallback) throw new Error("toolchain_unavailable");
	const request = [...currentRequestMessage(input).content]
		.slice(0, REQUEST_MAX_CHARS)
		.join("");
	const operation: ConversationOperation = {
		kind: "toolchain",
		toolchainId: fallback.toolchainId,
		revisionId: fallback.revisionId,
		functionName: fallback.functionName,
		request,
	};
	return {
		text: "",
		receipt: first.receipt,
		operation,
		selection: draft("toolchain", {
			toolchainId: fallback.toolchainId,
			toolchainRevisionId: fallback.revisionId,
			functionName: fallback.functionName,
			request,
			repaired: first.repaired,
		}),
		recallPins: [],
	};
}
