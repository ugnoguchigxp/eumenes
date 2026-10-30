/**
 * Composes the conversation's input for the harness measurement from the product's own functions: the system part
 * (`systemText` with the harness's sections), the recent conversation (`recentMessages` through
 * `conversationPrefixFrom`, over synthetic utterances), `## State` (`stateText`) and the last message
 * (`withLastMessage`). Nothing here calls a model or opens a database.
 */
import type { Database } from "bun:sqlite";
import { respondSystemParts } from "eumenes-agency";
import type {
	Utterance,
	UtteranceToolCall,
} from "../../api/domains/conversation";
import type {
	ChatMessage,
	DialogueDeps,
	RoutedInput,
} from "../../api/domains/dialogue/service/context";
import {
	systemText,
	type PersonaSpec,
} from "../../api/domains/dialogue/service/context-system";
import {
	conversationPrefixFrom,
	withLastMessage,
	type ConversationPrefix,
} from "../../api/domains/dialogue/service/conversation-input";
import { generationTools } from "../../api/domains/dialogue/service/generation-tools";
import {
	localHarness,
	type ConversationHarness,
} from "../../api/domains/dialogue/service/harness";
import {
	INPUT_HEADINGS,
	dataText,
	jstNowLine,
	lineText,
} from "../../api/domains/dialogue/service/input-text";
import {
	namedResources,
	stateText,
} from "../../api/domains/dialogue/service/state-text";
import { ASK_STEP } from "../../api/domains/dialogue/service/tool-exchange";

/** The agent's last words a choice call reads, at most (the product's bound). */
const PREVIOUS_REPLY_CHARS = 200;

/** The forms of the input a measurement compares. */
export const FORMS = ["current", "empty", "empty-last"] as const;
export type Form = (typeof FORMS)[number];

/** What the saved settings fix about the system part. */
export type SystemSource = {
	persona: PersonaSpec;
	interests: readonly string[];
	emotion: boolean;
	/** The titles of the toolchains the host can hand work to, in the product's order. */
	titles: readonly string[];
};

/** Every measured turn happens at this moment (Wednesday 10:00 in Asia/Tokyo), so the State line never moves. */
export const NOW_MS = Date.UTC(2026, 9, 28, 1, 0, 0);

/** The system part as the app builds it for the saved settings, in the harness's sections. */
export function buildSystem(
	source: SystemSource,
	harness: ConversationHarness,
): string {
	return systemText(
		source.persona,
		respondSystemParts({
			interests: source.interests.map((text, index) => ({
				id: `i${index + 1}`,
				text,
			})),
			spoken: true,
			emotion: source.emotion,
		}),
		source.titles,
		harness.system,
		harness.systemTexts,
	);
}

/** One thing said or noticed in the talk so far, before it is stored as an utterance. */
export type Entry = {
	role: "user" | "agent" | "notice";
	text: string;
	/** The carried tool calls of the turn an agent entry ends. */
	toolCalls?: UtteranceToolCall[];
};

/**
 * The talk as the conversation table holds it: a notice belongs to the agent utterance that reports it (the one
 * after it); a notice with no report after it is not kept.
 */
export function utterancesOf(log: readonly Entry[]): Utterance[] {
	const out: Utterance[] = [];
	let notice: string | null = null;
	for (const entry of log) {
		if (entry.role === "notice") {
			notice = entry.text;
			continue;
		}
		const seq = out.length + 1;
		out.push({
			conversationId: "harness",
			seq,
			speaker: entry.role,
			text: entry.text,
			messageId: null,
			at: new Date(NOW_MS - (log.length - seq + 1) * 5000).toISOString(),
			toolCalls: entry.role === "agent" ? (entry.toolCalls ?? []) : [],
			notice: entry.role === "agent" ? notice : null,
		});
		if (entry.role === "agent") notice = null;
	}
	return out;
}

/** A work the agent handed over, as the `仕事` lines of `## State` show it. */
export type Work = {
	ref: number;
	title: string;
	/** `reported`: the finished work was reported, and what it made is named. */
	state: "running" | "reported";
	made?: { ref: string; label: string };
};

/** The lines of `仕事:` and `提示中:` in the production's format (`state-text.ts`). */
export function workLines(
	works: readonly Work[],
	presented: string | null,
): string[] {
	const lines: string[] = [];
	if (works.length)
		lines.push(
			"仕事:",
			...works.map((work) => {
				const status = work.state === "reported" ? "報告済み" : "実行中";
				const made = work.made
					? ` ${work.made.ref}「${lineText(work.made.label)}」`
					: "";
				return `- t${work.ref} ${lineText(work.title)} ${status}${made}`;
			}),
		);
	if (presented) lines.push("提示中:", `- ${presented}（直前の返事で示した）`);
	return lines;
}

/** The request an agent entry asked back (its carried `ask` step), when it asked. */
function askedOf(entry: Entry | undefined): { request: string } | null {
	const step = entry?.toolCalls?.find((call) => call.name === ASK_STEP);
	if (!step) return null;
	try {
		const request = (JSON.parse(step.arguments) as { request?: unknown })
			.request;
		return typeof request === "string" && request.trim() ? { request } : null;
	} catch {
		return null;
	}
}

/** What a routed turn's choice call reads of the host's records, as the product draws them at the claim. */
export function routedInputOf(s: {
	log: readonly Entry[];
	works: readonly Work[];
	presented: string | null;
}): RoutedInput {
	const lastAgent = lastOf(s.log, (e) => e.role === "agent");
	const state = [
		`今: ${jstNowLine(NOW_MS)}`,
		...workLines(s.works, s.presented),
	];
	return {
		// The harness keeps no memory window (`composeInput` draws none); the user's earlier words, as many as the local
		// talk window keeps.
		memory: null,
		earlier: s.log
			.filter((e) => e.role === "user")
			.slice(-(localHarness.history.users ?? 0))
			.map((e) => lineText(e.text).slice(0, PREVIOUS_REPLY_CHARS))
			.filter((said) => said.trim()),
		state: stateText(state),
		previousReply: lastAgent
			? lineText(lastAgent.text).slice(0, PREVIOUS_REPLY_CHARS)
			: null,
		asked: askedOf(lastAgent),
		pending: { confirmations: [], questions: [] },
		// A reported work `## State` lists may only be checked, as in the product.
		todos: s.works.map(({ ref, title, state }) => ({
			ref,
			title,
			open: state === "running",
		})),
		resources: namedResources(state),
	};
}

/** The newest entry that matches (the runtime library has no `findLast`). */
export function lastOf(
	log: readonly Entry[],
	match: (entry: Entry) => boolean,
): Entry | undefined {
	for (let i = log.length - 1; i >= 0; i--) if (match(log[i]!)) return log[i];
	return undefined;
}

const quote = (text: string) =>
	`「${text.replace(/\s+/g, " ").trim().slice(0, 120)}」`;

/** The empty form's carry-over: the user's last words and the agent's last reply, as State lines. */
export function lastLines(log: readonly Entry[]): string[] {
	const user = lastOf(log, (e) => e.role === "user");
	const agent = lastOf(log, (e) => e.role === "agent" && !!e.text);
	return [
		...(user ? [`直前の利用者の発言: ${quote(user.text)}`] : []),
		...(agent ? [`直前のあなたの返事: ${quote(agent.text)}`] : []),
	];
}

/** The store the prefix reads from: only the utterances (no cut, no database). */
const storeOf = (utterances: readonly Utterance[]) =>
	({
		conversation: {
			input: {
				cutInTransaction: () => null,
				utterancesAfterInTransaction: () => [...utterances],
				latestUtterancesInTransaction: (
					_tx: unknown,
					_id: string,
					limit: number,
				) => utterances.slice(-limit),
			},
		},
	}) as unknown as DialogueDeps;

export type Situation = {
	form: Form;
	harness: ConversationHarness;
	system: string;
	log: readonly Entry[];
	works: readonly Work[];
	presented: string | null;
	say: string;
};

/**
 * The input of one step (for a routed harness, the talk turn's). `current` is the product's form (`## Memory`, the
 * recent conversation, then the last message); `empty` has neither the memory section nor the recent conversation;
 * `empty-last` is `empty` with the last words said as State lines. A routed harness's `## State` is the `今` line
 * alone: the works go to the choice input (`routedInputOf`) instead.
 */
export function composeInput(s: Situation): ChatMessage[] {
	const prefix: ConversationPrefix =
		s.form === "current"
			? conversationPrefixFrom(
					storeOf(utterancesOf(s.log)),
					null as unknown as Database,
					"harness",
					{
						harness: s.harness,
						system: s.system,
						window: null,
						pending: new Set(),
					},
				)
			: {
					messages: [{ role: "system", content: s.system }],
					tools: generationTools,
					carry: null,
					cut: null,
					recent: [],
					lastAt: null,
					since: null,
					memoryItemIds: [],
					memory: null,
					earlier: [],
				};
	const state = stateText([
		`今: ${jstNowLine(NOW_MS)}`,
		...(s.form === "empty-last" ? lastLines(s.log) : []),
		...(s.harness.turn === "routed" ? [] : workLines(s.works, s.presented)),
	]);
	return withLastMessage(prefix, [
		state,
		`${INPUT_HEADINGS.user}\n${dataText(s.say)}`,
	]);
}
