import { episodeTokens } from "../../../continuity";
import type { ConversationEvent, EpisodeSegment } from "../../../continuity";
import {
	EPISODE_INPUT_BYTES,
	MERGE_PARTS,
	SILENCE_BREAK_MS,
	type StepId,
} from "../../contracts";
import type { UnitTargets } from "../../repository";
import { byteLength, clipChars } from "../budget";
import { isRecord, loadEvent, localDay, text } from "../context";
import { instructions as refineInstructions } from "../prompts/refine-summary";
import { instructions as summarizeInstructions } from "../prompts/summarize";
import { refineSchema, summarizeSchema } from "../schemas";
import type {
	ApplyResult,
	PreparedUnit,
	StepDefinition,
	StepEnv,
} from "../types";
import { curatedOf, messageRefs } from "./shared";

const SUMMARY_CHARS = 1200;
/** The most event numbers one mark is scanned over (a mark is a range of moved events by `seq`). */
const MAX_SCAN = 5000;
/** What a logged action or notice shows the summary: the head of its own fields. */
const ACTION_CHARS = 300;

type Fitted = { fromSeq: number; toSeq: number };
type SummaryContext = {
	fitted: Fitted;
	count: number;
	fromAt: string;
	toAt: string;
	messageIds: string[];
	/** The episode tokens of what a merge replaces (a merge must be shorter). */
	replacedTokens: number | null;
};

/** One event as the summary reads it, or null when there is nothing to read (a delivery, a forgotten or blocked event). */
function eventEntry(
	env: StepEnv,
	event: ConversationEvent,
): { view: Record<string, unknown>; bytes: number } | null {
	if (event.forgotten || event.type === "delivered") return null;
	if (event.type === "said") {
		const loaded = loadEvent(env, event);
		if (loaded.status !== "ok") return null;
		const view = {
			id: event.id,
			at: event.at,
			by: loaded.event.by,
			...(loaded.event.origin ? { origin: loaded.event.origin } : {}),
			text: loaded.event.text.text,
			...(loaded.event.text.truncated ? { truncated: true } : {}),
		};
		return { view, bytes: loaded.event.bytes };
	}
	if (event.text === null) return null;
	let fields: unknown;
	try {
		fields = JSON.parse(event.text);
	} catch {
		return null;
	}
	if (!isRecord(fields)) return null;
	const { id: _id, at: _at, type: _type, by: _by, ...own } = fields;
	const what = clipChars(JSON.stringify(own), ACTION_CHARS);
	return {
		view: { id: event.id, at: event.at, type: event.type, by: event.by, what },
		bytes: byteLength(what),
	};
}

/**
 * The cut of an input that did not fit whole: the latest break in the talk (a gap of at least the silence break
 * between two events) inside what was read, so a summary does not end in the middle of an exchange; without one,
 * everything that was read.
 */
function alignedEnd(read: readonly ConversationEvent[]): number {
	for (let i = read.length - 1; i >= 1; i--)
		if (
			Date.parse(read[i]!.at) - Date.parse(read[i - 1]!.at) >=
			SILENCE_BREAK_MS
		)
			return i;
	return read.length;
}

function windowVersionOf(env: StepEnv): number {
	return env.deps.continuity.events.windowVersionInTransaction(
		env.db,
		env.conversationId,
	).version;
}

/** The newest shown summary, for the summary to follow on from. */
function earlierOf(env: StepEnv): string | null {
	const shown = env.deps.continuity.events.episodeInTransaction(
		env.db,
		env.conversationId,
		"shown",
	);
	return (
		[...shown].reverse().find((part) => part.kind === "summary")?.text ?? null
	);
}

// ---- summarize: the summary of the oldest events the next re-construction moves ----

function prepareSummarize(env: StepEnv, unit: { targets: UnitTargets }) {
	const { db, deps, conversationId } = env;
	const range = unit.targets.range;
	if (!range || range.of === "merge")
		return { status: "stale" as const, reason: "nothing_to_do" };
	const events = deps.continuity.events;
	// The events of the range, in the order they stand: the log's own order for the log, `seq` for a mark.
	let range_events: ConversationEvent[];
	if (range.of === "log") {
		range_events = events
			.logInTransaction(db, conversationId)
			.filter((e) => e.seq >= range.fromSeq && e.seq <= range.toSeq);
	} else {
		range_events = [];
		for (
			let seq = range.fromSeq;
			seq <= range.toSeq && seq - range.fromSeq < MAX_SCAN;
			seq++
		) {
			const event = events.eventInTransaction(db, conversationId, seq);
			if (event?.status === "moved") range_events.push(event);
		}
	}
	// What fits the input; a range that does not is summarized as far as it fits.
	const views: Array<Record<string, unknown>> = [];
	const read: ConversationEvent[] = [];
	const ids = new Set<string>();
	let bytes = 0;
	let cutAt = range_events.length;
	for (const [i, event] of range_events.entries()) {
		const entry = eventEntry(env, event);
		if (
			entry &&
			views.length > 0 &&
			bytes + entry.bytes > EPISODE_INPUT_BYTES
		) {
			cutAt = i;
			break;
		}
		read.push(event);
		if (entry) {
			views.push(entry.view);
			bytes += entry.bytes;
		}
	}
	let fitted = read;
	if (cutAt < range_events.length) fitted = read.slice(0, alignedEnd(read));
	const used = new Set(fitted.map((e) => e.seq));
	const keptViews = views.filter((view) =>
		used.has(Number(String(view.id).slice(1))),
	);
	if (keptViews.length === 0)
		return { status: "stale" as const, reason: "nothing_to_do" };
	for (const event of fitted) for (const id of event.messageIds) ids.add(id);
	const first = fitted[0]!;
	const last = fitted[fitted.length - 1]!;
	const context: SummaryContext = {
		fitted: {
			fromSeq: Math.min(...fitted.map((e) => e.seq)),
			toSeq: Math.max(...fitted.map((e) => e.seq)),
		},
		count: fitted.length,
		fromAt: first.at,
		toAt: last.at,
		messageIds: [...ids],
		replacedTokens: null,
	};
	// The log range keeps the first event's own number: a re-construction takes a summary only from there.
	if (range.of === "log") context.fitted.fromSeq = first.seq;
	return {
		status: "ready" as const,
		data: {
			today: localDay(deps.nowMs()),
			earlier: earlierOf(env),
			events: keptViews,
			curated: curatedOf(env, [...ids]),
		},
		targets: { range, fitted: context.fitted },
		windowVersion: windowVersionOf(env),
		context,
	};
}

/** The prepared episode with `summary` in it: what it overlaps is replaced. */
function writePrepared(env: StepEnv, summary: EpisodeSegment) {
	const { db, deps, conversationId } = env;
	const events = deps.continuity.events;
	const kept = events
		.episodeInTransaction(db, conversationId, "prepared")
		.filter(
			(part) => part.toSeq < summary.fromSeq || part.fromSeq > summary.toSeq,
		);
	events.writeEpisodeInTransaction(
		db,
		conversationId,
		"prepared",
		[...kept, summary].sort((a, b) => a.fromSeq - b.fromSeq),
	);
}

function applySummary(
	env: StepEnv,
	prepared: PreparedUnit,
	output: { summary: string },
	check: (context: SummaryContext, summary: EpisodeSegment) => boolean,
): ApplyResult {
	const context = prepared.context as SummaryContext;
	const base = {
		output,
		notices: [],
		changed: false,
		refs: messageRefs(context.messageIds),
	};
	const summary: EpisodeSegment = {
		kind: "summary",
		fromSeq: context.fitted.fromSeq,
		toSeq: context.fitted.toSeq,
		fromAt: context.fromAt,
		toAt: context.toAt,
		count: context.count,
		text: output.summary,
		messageIds: context.messageIds,
	};
	if (!check(context, summary))
		return {
			...base,
			applied: 0,
			rejected: 1,
			results: [{ status: "rejected", code: "not_shorter" }],
			unusable: true,
		};
	writePrepared(env, summary);
	return {
		...base,
		applied: 1,
		rejected: 0,
		results: [
			{
				status: "applied",
				from: summary.fromSeq,
				to: summary.toSeq,
				count: summary.count,
			},
		],
	};
}

const parseSummary = (raw: unknown): { summary: string } | null => {
	if (!isRecord(raw)) return null;
	const summary = text(raw.summary, SUMMARY_CHARS);
	return summary ? { summary } : null;
};

export const summarize: StepDefinition = {
	id: "summarize" satisfies StepId,
	slot: "episode",
	longTerm: false,
	instructions: summarizeInstructions,
	outputSchema: () => summarizeSchema,
	prepare: (env, unit) => prepareSummarize(env, unit),
	parse: parseSummary,
	apply: (env, prepared, output) =>
		applySummary(env, prepared, output as { summary: string }, () => true),
};

// ---- refine-summary: one summary for consecutive shown parts ----

function prepareRefine(env: StepEnv, unit: { targets: UnitTargets }) {
	const { db, deps, conversationId } = env;
	const range = unit.targets.range;
	if (!range || range.of !== "merge")
		return { status: "stale" as const, reason: "nothing_to_do" };
	const events = deps.continuity.events;
	const shown = events.episodeInTransaction(db, conversationId, "shown");
	const first = shown.findIndex((part) => part.fromSeq === range.fromSeq);
	const last = shown.findIndex((part) => part.toSeq === range.toSeq);
	if (first < 0 || last <= first)
		return { status: "stale" as const, reason: "nothing_to_do" };
	// The parts as the model reads them: a summary by its text, a mark by the words of its events.
	const taken: EpisodeSegment[] = [];
	const views: Array<Record<string, unknown>> = [];
	const ids = new Set<string>();
	let bytes = 0;
	for (const part of shown.slice(first, last + 1).slice(0, MERGE_PARTS)) {
		let view: Record<string, unknown>;
		const partIds: string[] = [];
		let size: number;
		if (part.kind === "summary") {
			view = {
				kind: "summary",
				from: part.fromAt,
				to: part.toAt,
				text: part.text,
			};
			partIds.push(...part.messageIds);
			size = byteLength(part.text);
		} else {
			const lines: Array<Record<string, unknown>> = [];
			size = 0;
			for (
				let seq = part.fromSeq;
				seq <= part.toSeq && seq - part.fromSeq < MAX_SCAN;
				seq++
			) {
				const event = events.eventInTransaction(db, conversationId, seq);
				if (event?.status !== "moved") continue;
				const entry = eventEntry(env, event);
				if (!entry) continue;
				lines.push(entry.view);
				size += entry.bytes;
				partIds.push(...event.messageIds);
			}
			view = {
				kind: "unsummarized",
				from: part.fromAt,
				to: part.toAt,
				events: lines,
			};
		}
		if (taken.length >= 2 && bytes + size > EPISODE_INPUT_BYTES) break;
		taken.push(part);
		views.push({ id: `p${taken.length}`, ...view });
		for (const id of partIds) ids.add(id);
		bytes += size;
	}
	if (taken.length < 2)
		return { status: "stale" as const, reason: "nothing_to_do" };
	const firstPart = taken[0]!;
	const lastPart = taken[taken.length - 1]!;
	const context: SummaryContext = {
		fitted: { fromSeq: firstPart.fromSeq, toSeq: lastPart.toSeq },
		count: taken.reduce((sum, part) => sum + part.count, 0),
		fromAt: firstPart.fromAt,
		toAt: lastPart.toAt,
		messageIds: [...ids],
		replacedTokens: episodeTokens(taken),
	};
	return {
		status: "ready" as const,
		data: { today: localDay(deps.nowMs()), parts: views },
		targets: { range, fitted: context.fitted },
		windowVersion: windowVersionOf(env),
		context,
	};
}

export const refineSummary: StepDefinition = {
	id: "refine-summary" satisfies StepId,
	slot: "episode",
	longTerm: false,
	instructions: refineInstructions,
	outputSchema: () => refineSchema,
	prepare: (env, unit) => prepareRefine(env, unit),
	parse: parseSummary,
	apply: (env, prepared, output) =>
		applySummary(
			env,
			prepared,
			output as { summary: string },
			(context, summary) =>
				context.replacedTokens === null ||
				episodeTokens([summary]) < context.replacedTokens,
		),
};
