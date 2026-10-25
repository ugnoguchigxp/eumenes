import type { Database } from "bun:sqlite";
import { estimateTextTokens } from "../../../infrastructure/context-budget";
import { referenceJson } from "../../../infrastructure/reference-json";
import type { ConversationEvent, EpisodeSegment } from "../contracts/events";
import {
	bumpWindowVersion,
	eventsWithStatus,
	moveEvents,
	readEpisode,
	setEventForm,
	writeEpisode,
} from "../repository/events";

/** One episode part as the conversation reads it (the ContextWindow specification, section 5.2). */
export function episodeFields(
	segment: EpisodeSegment,
): Record<string, unknown> {
	return {
		kind: segment.kind,
		from: segment.fromAt,
		to: segment.toAt,
		count: segment.count,
		...(segment.kind === "summary"
			? { text: segment.text }
			: { readWith: "conversation_history" }),
	};
}

/** Tokens of an episode as the document shows it. */
export function episodeTokens(segments: readonly EpisodeSegment[]): number {
	return estimateTextTokens(referenceJson(segments.map(episodeFields)));
}

/** What a re-construction keeps to (the window plan's sections and the log targets). */
export type ReconstructLimits = {
	log: { cap: number; high: number; low: number; keep: number };
	episode: number;
	/** The least time without events that counts as a break in the talk (ms). */
	silenceMs: number;
};

export type ReconstructReason =
	| "cache_lost"
	| "resumed"
	| "log_over_target"
	| "input_over_target"
	| "section_over_limit"
	| "immediate_change";

export type ReconstructResult = {
	version: number;
	moved: number;
	shortened: number;
	episodeTokens: number;
};

/**
 * How many of the oldest events to move so that what stays is at most `target` (section 8.3). Among the cuts that
 * leave between `keep` and `target` tokens, the latest break in the talk (a gap of at least `silenceMs` before the
 * first event that stays) is taken; without one, the smallest cut that fits.
 */
function cutBefore(
	log: readonly ConversationEvent[],
	target: number,
	keep: number,
	silenceMs: number,
): number {
	const total = log.reduce((sum, event) => sum + event.tokens, 0);
	if (total <= target) return 0;
	// `rest[i]`: the tokens that stay when the first `i` events move.
	const rest: number[] = Array.from({ length: log.length + 1 }, () => 0);
	for (let i = log.length - 1; i >= 0; i--)
		rest[i] = rest[i + 1]! + log[i]!.tokens;
	// `clean[i]`: every event that moves is older in receipt order than every event that stays. A user utterance
	// handled late sits after newer events in the log; cutting in front of it would split the receipt ranges the
	// episode is built from, so only clean cuts are taken (the steward's preparation uses the same rule).
	const clean: boolean[] = Array.from({ length: log.length + 1 }, () => false);
	let minAfter = Number.POSITIVE_INFINITY;
	const suffixMin: number[] = Array.from(
		{ length: log.length + 1 },
		() => Number.POSITIVE_INFINITY,
	);
	for (let i = log.length - 1; i >= 0; i--) {
		minAfter = Math.min(minAfter, log[i]!.seq);
		suffixMin[i] = minAfter;
	}
	let maxBefore = Number.NEGATIVE_INFINITY;
	for (let i = 1; i <= log.length; i++) {
		maxBefore = Math.max(maxBefore, log[i - 1]!.seq);
		clean[i] = maxBefore < suffixMin[i]!;
	}
	let smallest = -1;
	let silence = -1;
	let lastClean = 0;
	for (let i = 1; i < log.length; i++) {
		if (!clean[i]) continue;
		lastClean = i;
		if (rest[i]! > target) continue;
		if (smallest < 0) smallest = i;
		if (rest[i]! < keep) break;
		const gap = Date.parse(log[i]!.at) - Date.parse(log[i - 1]!.at);
		if (gap >= silenceMs) silence = i;
	}
	if (silence > 0) return silence;
	if (smallest > 0) return smallest;
	// No clean cut reaches the target: move as much as a clean cut allows.
	return lastClean;
}

function merged(segments: EpisodeSegment[]): EpisodeSegment[] {
	const out: EpisodeSegment[] = [];
	for (const segment of segments) {
		const last = out[out.length - 1];
		if (
			last &&
			last.kind === "unsummarized" &&
			segment.kind === "unsummarized"
		) {
			out[out.length - 1] = {
				...last,
				toSeq: segment.toSeq,
				toAt: segment.toAt,
				count: last.count + segment.count,
			};
		} else out.push(segment);
	}
	return out;
}

/**
 * The moved range as episode parts: the prepared summaries that lie inside it, and unsummarized marks for the
 * rest. A prepared summary that would only partly cover it is not used.
 */
function partsFor(
	moved: readonly ConversationEvent[],
	prepared: readonly EpisodeSegment[],
): EpisodeSegment[] {
	const parts: EpisodeSegment[] = [];
	let index = 0;
	while (index < moved.length) {
		const event = moved[index]!;
		const summary = prepared.find(
			(segment) =>
				segment.kind === "summary" &&
				segment.fromSeq === event.seq &&
				moved.some((e) => e.seq === segment.toSeq),
		);
		if (summary) {
			parts.push(summary);
			while (index < moved.length && moved[index]!.seq <= summary.toSeq)
				index++;
			continue;
		}
		parts.push({
			kind: "unsummarized",
			fromSeq: event.seq,
			toSeq: event.seq,
			fromAt: event.at,
			toAt: event.at,
			count: 1,
			text: "",
			messageIds: [],
		});
		index++;
	}
	return merged(parts);
}

/**
 * Prepared summaries applied to what is already shown: one whose range is exactly that of consecutive shown parts
 * replaces them (the steward merging summaries, or summarizing a whole mark); one inside a single unsummarized
 * mark takes its place in it, the rest of the mark staying a mark.
 */
function withLaterSummaries(
	shown: readonly EpisodeSegment[],
	prepared: readonly EpisodeSegment[],
): EpisodeSegment[] {
	let parts = [...shown];
	const used = new Set<EpisodeSegment>();
	for (const summary of prepared.filter((p) => p.kind === "summary")) {
		const first = parts.findIndex((p) => p.fromSeq === summary.fromSeq);
		const last = parts.findIndex((p) => p.toSeq === summary.toSeq);
		if (first < 0 || last < first) continue;
		parts = [...parts.slice(0, first), summary, ...parts.slice(last + 1)];
		used.add(summary);
	}
	const inside = prepared.filter((p) => p.kind === "summary" && !used.has(p));
	return merged(
		parts.flatMap((segment) => {
			if (segment.kind !== "unsummarized") return [segment];
			const within = inside.filter(
				(p) => p.fromSeq >= segment.fromSeq && p.toSeq <= segment.toSeq,
			);
			if (within.length === 0) return [segment];
			const parts: EpisodeSegment[] = [];
			let from = segment.fromSeq;
			let count = segment.count;
			for (const summary of [...within].sort((a, b) => a.fromSeq - b.fromSeq)) {
				if (summary.fromSeq > from)
					parts.push({
						...segment,
						fromSeq: from,
						toSeq: summary.fromSeq - 1,
						toAt: summary.fromAt,
						count: Math.max(0, count - summary.count),
					});
				parts.push(summary);
				count = Math.max(0, count - summary.count);
				from = summary.toSeq + 1;
			}
			if (from <= segment.toSeq)
				parts.push({ ...segment, fromSeq: from, fromAt: segment.fromAt });
			return parts.filter((part) => part.kind === "summary" || part.count > 0);
		}),
	);
}

/**
 * The episode within its limit without any model: the oldest parts lose their summary text first (a range mark
 * stays), marks next to each other become one, and if that is not enough the oldest parts are absorbed into one
 * leading mark ("before this, read the conversation history").
 */
export function fitEpisode(
	segments: readonly EpisodeSegment[],
	limit: number,
): EpisodeSegment[] {
	let parts = merged([...segments]);
	for (let i = 0; i < parts.length && episodeTokens(parts) > limit; i++) {
		if (parts[i]!.kind === "summary") {
			parts[i] = {
				...parts[i]!,
				kind: "unsummarized",
				text: "",
				messageIds: [],
			};
			parts = merged(parts);
			i = -1;
		}
	}
	while (parts.length > 1 && episodeTokens(parts) > limit) {
		const [first, second, ...rest] = parts;
		parts = [
			{
				kind: "unsummarized",
				fromSeq: first!.fromSeq,
				toSeq: second!.toSeq,
				fromAt: first!.fromAt,
				toAt: second!.toAt,
				count: first!.count + second!.count,
				text: "",
				messageIds: [],
			},
			...rest,
		];
	}
	return parts;
}

/**
 * One re-construction of a conversation's window (sections 8.3, 8.4, 9.3 and 12): moves the oldest events out to
 * the target (`keep` when the conversation resumed, `low` when the log is over `high` or its cap), adds the moved
 * range to the episode (prepared summaries where they cover it, unsummarized marks elsewhere), applies prepared
 * summaries to earlier marks, keeps the episode inside its limit, switches older memory
 * reads to their short form, and moves the window version. It never calls a model.
 */
export function reconstructInTransaction(
	db: Database,
	input: {
		conversationId: string;
		at: string;
		reason: ReconstructReason;
		limits: ReconstructLimits;
	},
): ReconstructResult {
	const { conversationId, limits } = input;
	const log = eventsWithStatus(db, conversationId, "logged");
	const total = log.reduce((sum, event) => sum + event.tokens, 0);
	const target =
		input.reason === "resumed"
			? limits.log.keep
			: total > limits.log.high || total > limits.log.cap
				? limits.log.low
				: null;
	const cut =
		target === null
			? 0
			: cutBefore(log, target, limits.log.keep, limits.silenceMs);
	const moved = log.slice(0, cut);
	const prepared = readEpisode(db, conversationId, "prepared");
	let episode = withLaterSummaries(
		readEpisode(db, conversationId, "shown"),
		prepared,
	);
	if (moved.length) {
		moveEvents(
			db,
			conversationId,
			moved.map((event) => event.seq),
		);
		episode = merged([...episode, ...partsFor(moved, prepared)]);
	}
	episode = fitEpisode(episode, limits.episode);
	writeEpisode(db, conversationId, "shown", episode);
	// What was prepared and is now applied (or lies before what is shown) is not kept twice.
	const shownUntil = episode[episode.length - 1]?.toSeq ?? 0;
	writeEpisode(
		db,
		conversationId,
		"prepared",
		prepared.filter((segment) => segment.fromSeq > shownUntil),
	);
	// Older memory reads keep their item ids only (section 8.4).
	const kept = log.slice(cut);
	let recent = 0;
	let shortened = 0;
	for (let i = kept.length - 1; i >= 0; i--) {
		const event = kept[i]!;
		recent += event.tokens;
		if (recent > limits.log.keep && event.shortable && event.form === "full") {
			setEventForm(db, conversationId, event.seq, "short");
			shortened++;
		}
	}
	const version = bumpWindowVersion(db, conversationId, input.at, input.reason);
	return {
		version,
		moved: moved.length,
		shortened,
		episodeTokens: episodeTokens(episode),
	};
}
