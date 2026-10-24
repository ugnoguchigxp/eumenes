import { type ConversationEvent, type EpisodeSegment } from "../../continuity";
import { episodeTokens } from "../../continuity";
import type { LogTargets } from "../../../infrastructure/context-budget";
import { MERGE_PARTS, MERGE_THRESHOLD, SILENCE_BREAK_MS } from "../contracts";
import type { StepEnv } from "./types";

/**
 * What the episode preparation does next (the ContextWindow specification, sections 8.3 and 12.2). Everything here
 * reads the log, the shown episode and the prepared episode only: nothing reads a message or calls a model.
 */
export type EpisodeCandidate = {
	step: "summarize" | "refine-summary";
	range: { fromSeq: number; toSeq: number; of: "log" | "mark" | "merge" };
};

/** The oldest logged events the next re-construction would move: the first `cut` events of the log. */
export type MoveRange = { cut: number; fromSeq: number; toSeq: number };

/**
 * The cuts that leave the log's `seq` order whole: every event before it has a lower `seq` than every event after
 * it (a user utterance handled late sits after newer events and keeps its own `seq`). A summary spans a `seq`
 * range, so only such a cut can be summarized.
 */
function cleanCuts(log: readonly ConversationEvent[]): boolean[] {
	const clean: boolean[] = Array.from({ length: log.length + 1 }, () => false);
	const minAfter: number[] = Array.from(
		{ length: log.length + 1 },
		() => Number.POSITIVE_INFINITY,
	);
	for (let i = log.length - 1; i >= 0; i--)
		minAfter[i] = Math.min(minAfter[i + 1]!, log[i]!.seq);
	let maxBefore = Number.NEGATIVE_INFINITY;
	for (let i = 1; i < log.length; i++) {
		maxBefore = Math.max(maxBefore, log[i - 1]!.seq);
		clean[i] = maxBefore < minAfter[i]!;
	}
	return clean;
}

/**
 * Where the next re-construction would cut the log, when it is over its target (null otherwise). The same rule as
 * the re-construction's: among the cuts that leave between `keep` and `low` tokens, the latest break in the talk
 * (a gap of `breakMs` before the first event that stays); without one the smallest cut that fits.
 */
export function moveRange(
	log: readonly ConversationEvent[],
	targets: LogTargets,
	breakMs = SILENCE_BREAK_MS,
): MoveRange | null {
	const total = log.reduce((sum, event) => sum + event.tokens, 0);
	if (total <= targets.high && total <= targets.cap) return null;
	if (log.length < 2) return null;
	const clean = cleanCuts(log);
	const rest: number[] = Array.from({ length: log.length + 1 }, () => 0);
	for (let i = log.length - 1; i >= 0; i--)
		rest[i] = rest[i + 1]! + log[i]!.tokens;
	let smallest = -1;
	let silence = -1;
	for (let i = 1; i < log.length; i++) {
		if (rest[i]! > targets.low) continue;
		if (clean[i] && smallest < 0) smallest = i;
		if (rest[i]! < targets.keep) break;
		if (!clean[i]) continue;
		const gap = Date.parse(log[i]!.at) - Date.parse(log[i - 1]!.at);
		if (gap >= breakMs) silence = i;
	}
	const cut = silence > 0 ? silence : smallest;
	if (cut <= 0) return null;
	let toSeq = log[0]!.seq;
	for (let i = 0; i < cut; i++) toSeq = Math.max(toSeq, log[i]!.seq);
	return { cut, fromSeq: log[0]!.seq, toSeq };
}

const sameRange = (
	a: { fromSeq: number; toSeq: number },
	b: { fromSeq: number; toSeq: number },
) => a.fromSeq === b.fromSeq && a.toSeq === b.toSeq;

/** The key an episode range is remembered by when there is nothing to prepare for it. */
export const rangeKey = (
	step: string,
	range: { fromSeq: number; toSeq: number; of: string },
) => `${step}:${range.of}:${range.fromSeq}-${range.toSeq}`;

/** The parts of a merge: the oldest consecutive shown parts. */
export function mergeParts(shown: readonly EpisodeSegment[]): EpisodeSegment[] {
	return shown.slice(0, MERGE_PARTS);
}

/**
 * The next preparation, in this order: the oldest events the next re-construction moves (when the log is over its
 * target), a merge of the oldest shown parts (when the episode nears its limit), the unsummarized marks. A range
 * that already has its prepared summary, or that was given up, is skipped.
 */
export function nextCandidate(
	env: StepEnv,
	skip: (candidate: EpisodeCandidate) => boolean,
): EpisodeCandidate | null {
	const { db, deps, conversationId } = env;
	const events = deps.continuity.events;
	const plan = deps.memory.windowPlan();
	const prepared = events
		.episodeInTransaction(db, conversationId, "prepared")
		.filter((part) => part.kind === "summary");
	const exact = (range: { fromSeq: number; toSeq: number }) =>
		prepared.some((part) => sameRange(part, range));
	const usable = (candidate: EpisodeCandidate) =>
		!exact(candidate.range) && !skip(candidate);

	const move = moveRange(events.logInTransaction(db, conversationId), plan.log);
	if (move) {
		const candidate: EpisodeCandidate = {
			step: "summarize",
			range: { fromSeq: move.fromSeq, toSeq: move.toSeq, of: "log" },
		};
		if (usable(candidate)) return candidate;
	}
	const shown = events.episodeInTransaction(db, conversationId, "shown");
	if (
		shown.length >= 2 &&
		episodeTokens(shown) >= MERGE_THRESHOLD * plan.sections.episode
	) {
		const parts = mergeParts(shown);
		const candidate: EpisodeCandidate = {
			step: "refine-summary",
			range: {
				fromSeq: parts[0]!.fromSeq,
				toSeq: parts[parts.length - 1]!.toSeq,
				of: "merge",
			},
		};
		if (usable(candidate)) return candidate;
	}
	for (const mark of shown.filter((part) => part.kind === "unsummarized")) {
		// The first stretch of the mark that no prepared summary lies in.
		const inside = prepared
			.filter((p) => p.fromSeq >= mark.fromSeq && p.toSeq <= mark.toSeq)
			.sort((a, b) => a.fromSeq - b.fromSeq);
		let from = mark.fromSeq;
		let to = mark.toSeq;
		for (const part of inside) {
			if (part.fromSeq > from) {
				to = part.fromSeq - 1;
				break;
			}
			from = part.toSeq + 1;
		}
		if (from > mark.toSeq) continue;
		const candidate: EpisodeCandidate = {
			step: "summarize",
			range: { fromSeq: from, toSeq: to, of: "mark" },
		};
		if (usable(candidate)) return candidate;
	}
	return null;
}
