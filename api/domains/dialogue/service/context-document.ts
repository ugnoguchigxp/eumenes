import { estimateTextTokens } from "../../../infrastructure/context-budget";
import { referenceJson } from "../../../infrastructure/reference-json";
import {
	episodeFields,
	type ActiveSlot,
	type ContinuityItem,
	type ConversationEvent,
	type EpisodeSegment,
} from "../../continuity";
import type { ContextBlock } from "../../inference";
import { keepOrder, profileItemFields, type ProfileItem } from "../../memory";

/**
 * The material document of a generation (the ContextWindow specification, section 5.2): one JSON object whose keys
 * come in a fixed order, from what changes least to what changes every time. Each section is rendered from its
 * sources alone, so the same sources always give the same text, and the frozen texts of the log and the work
 * results are joined as they are.
 */
export const DOCUMENT_KEYS = [
	"profile",
	"episode",
	"log",
	"active",
	"state",
	"now",
	"work",
] as const;
export type DocumentKey = (typeof DOCUMENT_KEYS)[number];

/** A TODO as the conversation sees it: a projection of the execution ledger (section 10.1). */
export type TodoItem = {
	id: string;
	title: string;
	status: "todo" | "waiting" | "done";
	outcome?: string;
	revision: number;
	updatedAt: string;
	questionId?: string;
	question?: string;
};

/** A confirmation the host issued before executing a change (section 6.7). */
export type PendingConfirmation = {
	id: string;
	toolchain: string;
	request: string;
	impact: string;
	expiresAt: string;
};

/** What the state section is made of: the TODOs, the host's records and the short-term notes. */
export type StateSources = {
	todos: readonly TodoItem[];
	pendingConfirmation: readonly PendingConfirmation[];
	retained: ReadonlyArray<{ id: string; summary: string }>;
	/** The memory steward's notes of this conversation (decisions, questions to the user, goals, memos). */
	notes: readonly ContinuityItem[];
	/** The adopted goals of the goals domain. */
	goals: ReadonlyArray<{ id: string; text: string; priority: number }>;
	/** Long-term items waiting to join the profile. */
	newMemories: readonly ProfileItem[];
};

/** What holds for this generation only. */
export type NowSources = {
	at: string;
	trigger: ReadonlyArray<Record<string, unknown>>;
	/** The event id of the utterance being delivered, if any. */
	speaking: string | null;
	notices: readonly string[];
	/** Recalled earlier exchanges (the automatic recall). */
	recall: ReadonlyArray<Record<string, unknown>>;
	/** What the agency shows besides its own utterances (those are in the log). */
	agency: ReadonlyArray<string>;
	/** Other records of this call the host keeps (a World names hint, a specialist work record). */
	records: readonly ContextBlock[];
};

export type DocumentSources = {
	/** The published profile, in its order. */
	profile: readonly ProfileItem[];
	episode: readonly EpisodeSegment[];
	/** The logged events, in log order. */
	log: readonly ConversationEvent[];
	active: readonly ActiveSlot[];
	state: StateSources;
	now: NowSources;
	/** This call's material in full (operation results, a report, a document the user asked about). */
	work: readonly ContextBlock[];
};

export type RenderedSection = { text: string; tokens: number };
export type ContextDocument = {
	sections: Record<DocumentKey, RenderedSection>;
	/** The whole document: `{"profile":…,"episode":…,…}`. */
	text: string;
	tokens: number;
};

const NOTE_KEYS: Record<string, "decisions" | "askedUser" | "goals" | "notes"> =
	{
		decision: "decisions",
		open_question: "askedUser",
		goal: "goals",
		activity: "notes",
		memo: "notes",
	};

/** The profile within its budget: kept in keep order, shown in published order. */
export function fitProfile(
	items: readonly ProfileItem[],
	limit: number,
): ProfileItem[] {
	const kept = new Set<string>();
	let used = estimateTextTokens("[]");
	for (const item of keepOrder(items)) {
		const tokens =
			estimateTextTokens(referenceJson(profileItemFields(item))) + 1;
		if (used + tokens > limit) continue;
		kept.add(item.id);
		used += tokens;
	}
	return items.filter((item) => kept.has(item.id));
}

/** A block of this call as the document shows it: its labels, then its data. */
export function blockFields(block: ContextBlock): Record<string, unknown> {
	const body =
		block.body.kind === "json"
			? { data: block.body.value }
			: block.body.kind === "text"
				? { text: block.body.text }
				: {
						...(block.body.header ? { header: block.body.header } : {}),
						sections: block.body.sections,
					};
	return {
		source: block.source,
		authority: block.authority,
		...(block.certainty ? { certainty: block.certainty } : {}),
		...(block.covers ? { covers: block.covers } : {}),
		...body,
	};
}

function stateValue(state: StateSources): Record<string, unknown> {
	const grouped = {
		decisions: [],
		askedUser: [],
		goals: [],
		notes: [],
	} as Record<
		"decisions" | "askedUser" | "goals" | "notes",
		Array<Record<string, unknown>>
	>;
	for (const note of state.notes) {
		const key = NOTE_KEYS[note.kind];
		if (key)
			grouped[key].push({
				id: note.id,
				text: note.text,
				...(note.expiresAt ? { until: note.expiresAt } : {}),
			});
	}
	return {
		todos: state.todos.map((todo) => ({
			id: todo.id,
			title: todo.title,
			status: todo.status,
			...(todo.outcome ? { outcome: todo.outcome } : {}),
			revision: todo.revision,
			updatedAt: todo.updatedAt,
			...(todo.questionId
				? { questionId: todo.questionId, question: todo.question }
				: {}),
		})),
		pendingConfirmation: state.pendingConfirmation,
		retained: state.retained,
		decisions: grouped.decisions,
		askedUser: grouped.askedUser,
		goals: [
			...state.goals.map((goal) => ({ id: goal.id, text: goal.text })),
			...grouped.goals,
		],
		newMemories: state.newMemories.map(profileItemFields),
		notes: grouped.notes,
	};
}

const section = (text: string): RenderedSection => ({
	text,
	tokens: estimateTextTokens(text),
});

/**
 * Renders the document. The profile is fitted to `profileLimit`; every other section is rendered as given (the
 * re-construction and the caller keep them inside their budgets).
 */
export function renderDocument(
	sources: DocumentSources,
	profileLimit: number,
): ContextDocument {
	const sections: Record<DocumentKey, RenderedSection> = {
		profile: section(
			referenceJson(
				fitProfile(sources.profile, profileLimit).map(profileItemFields),
			),
		),
		episode: section(referenceJson(sources.episode.map(episodeFields))),
		log: section(
			`[${sources.log
				.map((event) => event.text)
				.filter((text): text is string => text !== null)
				.join(",")}]`,
		),
		active: section(`[${sources.active.map((slot) => slot.text).join(",")}]`),
		state: section(referenceJson(stateValue(sources.state))),
		now: section(
			referenceJson({
				at: sources.now.at,
				trigger: sources.now.trigger,
				speaking: sources.now.speaking,
				notices: sources.now.notices,
				recall: sources.now.recall,
				agency: sources.now.agency,
				...(sources.now.records.length
					? { records: sources.now.records.map(blockFields) }
					: {}),
			}),
		),
		work: section(referenceJson(sources.work.map(blockFields))),
	};
	const text = `{${DOCUMENT_KEYS.map((key) => `"${key}":${sections[key].text}`).join(",")}}`;
	return { sections, text, tokens: estimateTextTokens(text) };
}
