import { systemContext } from "../../infrastructure/system-context";
import {
	createAgendaAgent,
	defaultPersona,
	speechIntervals,
	type AgendaAddedWords,
	type AgendaAgent,
	type NoteRef,
	type ReplyCall,
	type SpeechIntervalSec,
} from "eumenes-agency/agenda";
import type { InputContext, LlmPort, LlmRequest } from "eumenes-agency";
import { createAgendaSteering } from "./agenda-steer";
import {
	conversationPersona,
	isAgendaSnapshot,
	type AgencyRecord,
	type AgendaHostSnapshot,
	type AgendaNote,
	type AgendaProfile,
	type AgendaResearchTicket,
	agendaSources,
} from "../../domains/dialogue";
import type { AgencyHostDeps } from "./host-types";
import type { AgencyThought } from "../../domains/dialogue/contracts/agency-status";
import type { Unheard } from "./always-on-heard";

/** Notes kept per conversation: the newest ones (the older are still in the work ledger). */
export const NOTES_KEPT = 30;

/** Whether the agenda can serve replies and think: the runtime is on, with a healthy memory and the ledger. */
export const agendaReady = (deps: AgencyHostDeps) =>
	deps.settings.get().agency.runtime === "always-on" &&
	deps.memory.status().healthy &&
	!!deps.state &&
	!!deps.memory.referenceInputs;

/** Local time as the user would say it (the CLI's format): "2026/11/11(水) 14:02", in Japan time. */
export const agendaClock = (at: number) =>
	new Date(at).toLocaleString("ja-JP", {
		timeZone: "Asia/Tokyo",
		weekday: "short",
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});

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
	steering: AgendaAddedWords | null;
	tickets: AgendaResearchTicket[];
	notes: AgendaNote[];
	/**
	 * The notes the list let go (it keeps the newest), as their references only. A note that left the list is not a
	 * forgotten one: what rests on it (a reply being written, a line, a research) is still whole while the words the
	 * note read are there. Not saved with the checkpoint.
	 */
	retired: Array<{ id: string; refs: string[] }>;
	/** Results that came before the agent asked again for the item (after a restart): told when it does. */
	finished: Map<
		string,
		{ status: "succeeded" | "failed"; note: AgendaNote | null }
	>;
	/** The step out now: the user's words call it off. */
	controller: AbortController | null;
	stepDiagnostic: ReturnType<
		NonNullable<AgencyHostDeps["backgroundDiagnostic"]>
	>;
	stepping: boolean;
	again: boolean;
	timer: unknown;
	backoffUntil: number;
	busy: boolean;
	/** The research that waited when a step last ran while the user was typing or answered (see `mayStep`). */
	triedWhileBusy: string;
	touched: number;
	/** The reply being written (its run and the user's messages its prompt holds already). */
	reply: { runId: string; included: Set<string> } | null;
	/** What each reply did, until its message is observed (the agent's record of its own tool calls). */
	calls: Map<string, readonly ReplyCall[]>;
	/** The user's messages a reply of the run took into a model call (eumenes-steer). */
	taken: Map<string, string[]>;
	/** The user's plans and interests (the package's profile note), written behind the talk. */
	profile: AgendaProfile;
	/** The words the profile writer has read already. */
	profileSeen: Set<string>;
	/** The writer's passes, one after another. */
	profileWriting: Promise<void>;
	/** Ends the writer's call when the scope goes. */
	profileAbort: AbortController;
	/** Grows with every forget: a writer pass that began before one is not kept. */
	forgetSeq: number;
	/** The agency's calls without the step's staleness rules (the profile writer runs beside the user's words). */
	background: LlmPort;
	/** What each reply was given (memory, notes, the agent's state), as references: captured again when it is adopted. */
	given: Map<string, string[]>;
	/** The notes a reply showed (show_note), shown to the user once the reply is adopted. */
	shows: Map<string, string[]>;
	/** The input of each line handed to a Live session as a proposal (the session asks for it when it speaks). */
	proposals: Map<string, InputContext>;
	/** Words of the agent a screen may still be reading aloud: said (to the agent) when the reading ends. */
	unheard: Unheard[];
	/** What the agent thought lately, for the chat column (display only: not saved, cleared by a forget). */
	thoughts: AgencyThought[];
	thoughtSeq: number;
	/** Tells the screens a thought was added. */
	thoughtsChanged(): void;
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
		...(c.profile.markdown || c.profile.passes.length
			? { profile: structuredClone(c.profile) }
			: {}),
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

/** The notes a reference may name: those the list holds, and those it let go (`AgendaScope.retired`). */
export const citableNotes = (
	c: Pick<AgendaScope, "notes" | "retired">,
): Array<{ id: string; refs: readonly string[] }> => [...c.notes, ...c.retired];

/** How many notes the list let go are still known by their references. */
const RETIRED_KEPT = 200;

/** Adds a note to the scope's list. The notes the list lets go for it stay citable (`AgendaScope.retired`). */
export function holdNote(
	c: Pick<AgendaScope, "notes" | "retired">,
	kept: AgendaNote[],
) {
	c.retired = [
		...c.retired,
		...c.notes
			.filter((n) => !kept.some((k) => k.id === n.id))
			.map((n) => ({ id: n.id, refs: [...n.refs] })),
	].slice(-RETIRED_KEPT);
	c.notes = kept;
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
			const diagnostic = c.stepDiagnostic;
			const result = await inner.complete(
				{
					...request,
					system: `${request.system}\n${systemContext("dialogue.contexts.agency.diagnostic-records", {})}`,
					...(diagnostic
						? {
								prompt: `${request.prompt}\n\nEumenes の内部記録（データ）\n${diagnostic.text}`,
							}
						: {}),
				},
				signal,
			);
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
		profile: () => c.profile.markdown,
		clock: agendaClock,
		startedAt: now(),
		...(restored ? { restore: restored.agent } : {}),
	});
	const steering = deps.steering
		? createAgendaSteering({
				inbox: deps.steering,
				read: input.text,
				now,
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
		profile: structuredClone(
			restored?.profile ?? { markdown: "", base: "", passes: [] },
		),
		profileSeen: new Set(),
		profileWriting: Promise.resolve(),
		profileAbort: new AbortController(),
		forgetSeq: 0,
		background: inner,
		finished: new Map(),
		controller: null,
		stepDiagnostic: null,
		stepping: false,
		again: false,
		timer: undefined,
		backoffUntil: 0,
		triedWhileBusy: "",
		retired: [],
		busy: false,
		touched: now(),
		reply: null,
		calls: new Map(),
		taken: new Map(),
		proposals: new Map(),
		given: new Map(),
		shows: new Map(),
		unheard: [],
		thoughts: [],
		thoughtSeq: 0,
		thoughtsChanged: () => deps.publish?.(),
		kick: () => input.kick(c),
	};
	return c;
}
