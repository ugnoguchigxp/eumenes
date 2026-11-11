import {
	createAgendaAgent,
	createAgendaReplySteering,
	defaultPersona,
	speechIntervals,
	type AgendaAgent,
	type AgendaReplySteering,
	type NoteRef,
	type ReplyCall,
	type SpeechIntervalSec,
} from "eumenes-agency/agenda";
import type { InputContext, LlmPort, LlmRequest } from "eumenes-agency";
import {
	conversationPersona,
	isAgendaSnapshot,
	type AgencyRecord,
	type AgendaHostSnapshot,
	type AgendaNote,
	type AgendaResearchTicket,
	agendaSources,
} from "../../domains/dialogue";
import { promptTime } from "../../domains/inference";
import type { AgencyHostDeps } from "./host-types";

/** Notes kept per conversation: the newest ones (the older are still in the work ledger). */
export const NOTES_KEPT = 30;

/** Whether the agenda can serve replies and think: the runtime is on, with a healthy memory and the ledger. */
export const agendaReady = (deps: AgencyHostDeps) =>
	deps.settings.get().agency.runtime === "always-on" &&
	deps.memory.status().healthy &&
	!!deps.state &&
	!!deps.memory.referenceInputs;

/** The user's setting allows 10/60/600 s; the agenda knows 10/60/300 s (600 is read as 300). */
export const agendaInterval = (sec: number | undefined): SpeechIntervalSec =>
	sec === undefined
		? 10
		: (speechIntervals.find((n) => n === sec) ?? (sec >= 300 ? 300 : 10));

export type AgendaScope = {
	id: string;
	scope: string;
	epoch: number;
	/** Grows with the user's words, a correction and a forget: a model call that began before it is stale. */
	generation: number;
	revision: number;
	agent: AgendaAgent;
	/** Absent when the server made no steering inbox: words sent meanwhile wait for a reply of their own. */
	steering: AgendaReplySteering | null;
	tickets: AgendaResearchTicket[];
	notes: AgendaNote[];
	/** Results that came before the agent asked again for the item (after a restart): told when it does. */
	finished: Map<
		string,
		{ status: "succeeded" | "failed"; note: AgendaNote | null }
	>;
	/** The step out now: the user's words call it off. */
	controller: AbortController | null;
	stepping: boolean;
	again: boolean;
	timer: unknown;
	backoffUntil: number;
	busy: boolean;
	touched: number;
	/** The reply being written (its run and the user's messages its prompt holds already). */
	reply: { runId: string; included: Set<string> } | null;
	/** What each reply did, until its message is observed (the agent's record of its own tool calls). */
	calls: Map<string, readonly ReplyCall[]>;
	/** The user's messages a reply of the run took into a model call (eumenes-steer). */
	taken: Map<string, string[]>;
	/** What each reply was given (memory, notes, the agent's state), as references: captured again when it is adopted. */
	given: Map<string, string[]>;
	/** The notes a reply showed (show_note), shown to the user once the reply is adopted. */
	shows: Map<string, string[]>;
	/** The input of each line handed to a Live session as a proposal (the session asks for it when it speaks). */
	proposals: Map<string, InputContext>;
	/** The host's step, run by the scheduler (set by the host). */
	kick(): void;
};

export function agendaEnvelope(c: AgendaScope, at: number): AgendaHostSnapshot {
	return {
		kind: "agenda",
		version: 1,
		revision: c.revision,
		agent: c.agent.snapshot(at),
		tickets: structuredClone(c.tickets),
		notes: structuredClone(c.notes),
	};
}

export function agendaRecord(
	c: AgendaScope,
	settingsDigest: string,
	at: number,
): AgencyRecord {
	const snapshot = agendaEnvelope(c, at);
	return {
		conversationId: c.id,
		scope: c.scope,
		epoch: c.epoch,
		snapshot,
		idle: null,
		settingsDigest,
		sourceRefs: agendaSources(snapshot),
	};
}

export const noteRef = (n: AgendaNote): NoteRef => ({
	id: n.id,
	title: n.title,
	summary: n.summary,
	at: n.at,
	refs: n.refs,
});

/** The memory's active items as the agent reads them (`memory:<id>`), without what is out of its validity. */
export function knownOf(deps: AgencyHostDeps, now: number) {
	const status = deps.memory.status();
	if (!status.enabled || !status.healthy) return [];
	return deps.memory
		.list()
		.filter(
			(item) =>
				item.status === "active" &&
				(item.validFromMs === null || item.validFromMs <= now) &&
				(item.validUntilMs === null || item.validUntilMs > now),
		)
		.map((item) => ({
			id: item.id,
			text: `${item.polarity === "negated" ? "（否定）" : ""}${item.text}`,
		}));
}

/** The agent's voice: the built-in purpose, the configured persona and the standing interests. */
function personaOf(deps: AgencyHostDeps) {
	const cfg = deps.settings.get();
	const own = conversationPersona(cfg.general);
	return [
		defaultPersona,
		own.role,
		own.style,
		cfg.agency.interests.length
			? `あなた自身の関心: ${cfg.agency.interests.join(" / ")}`
			: "",
	]
		.filter(Boolean)
		.join("\n");
}

export function createAgendaScope(input: {
	deps: AgencyHostDeps;
	id: string;
	epoch: number;
	previous?: AgencyRecord;
	now(): number;
	/** Read a user's message for a steered model call (null: forgotten or not the user's). */
	text(messageId: string): string | null;
	kick(c: AgendaScope): void;
}) {
	const { deps, id, now } = input;
	const cfg = deps.settings.get();
	const restored =
		input.previous && isAgendaSnapshot(input.previous.snapshot)
			? input.previous.snapshot
			: undefined;
	let c: AgendaScope;
	// The agenda's calls are short structured outputs: reasoning must not eat their output budget.
	const inner = deps.createLlm(() => ({
		decisionId: crypto.randomUUID(),
		generation: c.generation,
		conversationId: id,
		independent: true,
		...(cfg.agency.thinkResourceId
			? { resourceId: cfg.agency.thinkResourceId }
			: {}),
		reasoning: cfg.agency.thinkReasoning ?? "low",
	}));
	// A call that began before the user's words, a correction or a forget is stale when it returns.
	const llm: LlmPort = {
		async complete<T>(request: LlmRequest<T>, signal: AbortSignal) {
			const started = c.generation;
			signal.throwIfAborted();
			const result = await inner.complete(request, signal);
			if (c.generation !== started || signal.aborted)
				throw new DOMException("agenda_stale", "AbortError");
			return result;
		},
	};
	const agent = createAgendaAgent({
		llm,
		known: () => knownOf(deps, now()),
		notes: () => c.notes.map(noteRef),
		persona: personaOf(deps),
		speechIntervalSec: agendaInterval(cfg.agency.speechIntervalSec),
		clock: (at) => promptTime(at).now,
		startedAt: now(),
		...(restored ? { restore: restored.agent } : {}),
	});
	const steering = deps.steering
		? createAgendaReplySteering({
				inbox: deps.steering,
				read: input.text,
				now,
				// Replies stream to the user as they are written: the first answer stands.
				holdsText: false,
				targetPrefix: `agenda-reply:${id}:`,
			})
		: undefined;
	c = {
		id,
		scope: input.previous?.scope ?? crypto.randomUUID(),
		epoch: input.epoch,
		generation: 1,
		revision: restored?.revision ?? 0,
		agent,
		steering: steering ?? null,
		tickets: structuredClone(restored?.tickets ?? []),
		notes: structuredClone(restored?.notes ?? []),
		finished: new Map(),
		controller: null,
		stepping: false,
		again: false,
		timer: undefined,
		backoffUntil: 0,
		busy: false,
		touched: now(),
		reply: null,
		calls: new Map(),
		taken: new Map(),
		proposals: new Map(),
		given: new Map(),
		shows: new Map(),
		kick: () => input.kick(c),
	};
	return c;
}
