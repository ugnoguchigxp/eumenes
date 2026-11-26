import { systemContext } from "../../infrastructure/system-context";
import {
	createAgendaAgent,
	defaultPersona,
	speechIntervals,
	type AgendaAgent,
	type AgendaSnapshot,
	type NoteRef,
	type ReplyCall,
	type SpeechIntervalSec,
} from "eumenes-agency/agenda";
import type { InputContext, LlmPort, LlmRequest } from "eumenes-agency";
import { createAgendaSteering, type AgendaSteering } from "./agenda-steer";
import {
	conversationPersona,
	isAgendaSnapshot,
	type AgencyRecord,
	type AgendaHostSnapshot,
	type AgendaNote,
	type AgendaResearchRefusal,
	type AgendaResearchTicket,
	type AgendaAssignment,
	agendaSources,
	READ_MEMORY_LIMIT,
} from "../../domains/dialogue";
import type { AgencyHostDeps } from "./host-types";
import type { WorkObservation } from "./work-observation";
import { completeBackgroundPlan } from "./background-plan";
import { prepareResearch } from "./research-admission";
import { knownFor, marksFor, recordsFor, saidOf } from "./always-on-recall";
import { takePosition } from "./always-on-position";
import type { AgencyThought } from "../../domains/dialogue/contracts/agency-status";
import type { Unheard } from "./always-on-heard";

/** How long a line handed to a Live session is waited on for the words that say it. */
export const ROUTED_WAIT_MS = 10 * 60_000;

/** Notes kept per conversation: the newest ones (the older are still in the work ledger). */
export const NOTES_KEPT = 30;

/** Whether the agenda can serve replies and think: a healthy memory and the ledger. */
export const agendaReady = (deps: AgencyHostDeps) =>
	deps.memory.status().healthy && !!deps.state && !!deps.memory.referenceInputs;

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
	steering: AgendaSteering | null;
	tickets: AgendaResearchTicket[];
	notes: AgendaNote[];
	researchRefusals: Map<string, AgendaResearchRefusal>;
	/** What the user asked toolchains for (`delegate`), by the agent's item id, until the item ends. */
	assignments: Map<string, AgendaAssignment>;
	/** The last progress and question each running assignment told the agent (not saved: told again after a restart). */
	observed: Map<string, string>;
	/**
	 * The notes the list let go (it keeps the newest), as their references only. A note that left the list is not a
	 * forgotten one: what rests on it (a reply being written, a line, a research) is still whole while the words the
	 * note read are there. Not saved with the checkpoint.
	 */
	retired: Array<{ id: string; refs: string[]; inputs?: string[] }>;
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
	stepWork: WorkObservation | null;
	workVersion: string | undefined;
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
	/**
	 * The outbox seq of the last event the records writer has read (saved with the checkpoint, in the transaction of
	 * what the pass wrote): the next pass reads the conversation's words after it. Moves only when a pass was kept.
	 * null: no position is known (the first pass starts a little before the end of the conversation).
	 */
	recordsSeq: number | null;
	/** Ends the records writer's call (and a note's display) when the scope goes. */
	closed: AbortController;
	/** The writer's pass while one runs (one at a time); `again` is set by a reply that came in meanwhile. */
	recordsRun: { again: boolean } | null;
	/** A pass was called off or failed: it owes a read of the words after `recordsSeq`. */
	recordsOwed: boolean;
	/** Grows with every forget: a writer pass that began before one is not kept. */
	forgetSeq: number;
	/** `memory:<id>` versions a consolidation replaced that the agent's items still cite, to their successors (saved so). */
	renames: Map<string, string>;
	/** The `memory:<id>` items the calls of the agent were given lately (what its input rests on). */
	shown: Set<string>;
	/** The agency's calls without the step's staleness rules (the records writer runs beside the user's words). */
	background: LlmPort;
	/** What each reply was given (memory, notes, the agent's state), as references: captured again when it is adopted. */
	given: Map<string, string[]>;
	/** The notes a reply showed (show_note), shown to the user once the reply is adopted. */
	shows: Map<string, string[]>;
	/** The input of each line handed to a Live session as a proposal (the session asks for it when it speaks). */
	proposals: Map<string, InputContext>;
	/**
	 * The work behind each line handed to a Live session (by the line's id), until the session's own words carry it: the
	 * transcript of what it says is the message that shows the line's resource chips. Not saved.
	 */
	routed: Map<string, { at: number; findings: readonly string[] }>;
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

/** What the host keeps in the record's `idle` slot: the records writer's position. */
export type AgencyRecordSlot = { recordsSeq: number | null };

/** Where the records writer stopped in a saved record (null: not known). */
export const positionOf = (record: AgencyRecord | undefined): number | null => {
	const idle = record?.idle;
	return typeof idle === "object" &&
		idle !== null &&
		typeof (idle as AgencyRecordSlot).recordsSeq === "number"
		? (idle as AgencyRecordSlot).recordsSeq
		: null;
};

/** The agent's snapshot with the references of replaced versions turned to the versions that took their place. */
export const renamed = (
	snapshot: AgendaSnapshot,
	renames: ReadonlyMap<string, string>,
): AgendaSnapshot =>
	renames.size === 0
		? snapshot
		: {
				...snapshot,
				items: snapshot.items.map((item) => ({
					...item,
					refs: item.refs.map((ref) => renames.get(ref) ?? ref),
				})),
			};

export function agendaEnvelope(c: AgendaScope, at: number): AgendaHostSnapshot {
	return {
		kind: "agenda",
		version: 1,
		revision: c.revision,
		agent: renamed(c.agent.snapshot(at), c.renames),
		tickets: structuredClone(c.tickets),
		notes: structuredClone(c.notes),
		...(c.researchRefusals.size
			? { researchRefusals: structuredClone([...c.researchRefusals.values()]) }
			: {}),
		// An assignment is kept while its item waits or runs; the item holds what came of it after.
		assignments: structuredClone(
			[...c.assignments.values()].filter((a) =>
				c.agent
					.view()
					.items.some(
						(i) =>
							i.id === a.itemId &&
							(i.status === "open" || i.status === "doing"),
					),
			),
		),
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
		// The record's own slot beside the snapshot (the contract of the snapshot is the dialogue domain's).
		idle: { recordsSeq: c.recordsSeq } satisfies AgencyRecordSlot,
		settingsDigest,
		sourceRefs: agendaSources(snapshot),
	};
}

/** The notes a reference may name: those the list holds, and those it let go (`AgendaScope.retired`). */
export const citableNotes = (
	c: Pick<AgendaScope, "notes" | "retired">,
): Array<{
	id: string;
	refs: readonly string[];
	inputs?: readonly string[];
}> => [...c.notes, ...c.retired];

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
			.map((n) => ({
				id: n.id,
				refs: [...n.refs],
				...(n.inputs ? { inputs: [...n.inputs] } : {}),
			})),
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

/** Every active memory item of the user (`memory:<id>`), without what is out of its validity, newest update first. */
function activeMemory(deps: AgencyHostDeps, now: number) {
	const status = deps.memory.status();
	if (!status.enabled || !status.healthy) return [];
	return deps.memory
		.list()
		.filter(
			(item) =>
				item.status === "active" &&
				(item.validFromMs === null || item.validFromMs <= now) &&
				(item.validUntilMs === null || item.validUntilMs > now),
		);
}

/** How many memory refs the scope remembers having shown (the newest ones). */
const SHOWN_KEPT = 200;

/**
 * The `memory:<id>` items the agent's calls were given lately that are still in force now: what a research or a
 * line it makes may rest on (a superseded or forgotten one is no longer in force, and is not recorded as seen).
 */
export function shownMemory(
	deps: AgencyHostDeps,
	c: Pick<AgendaScope, "shown">,
	now: number,
) {
	const active = new Set(activeMemory(deps, now).map((item) => item.id));
	return [...c.shown].filter((ref) => active.has(ref.slice("memory:".length)));
}

/** The user's recent words and the memory given to the agenda's recent calls. */
export function seenRefs(
	deps: AgencyHostDeps,
	c: AgendaScope,
	now: number,
): string[] {
	return [
		...c.agent
			.view()
			.said.filter((s) => s.who === "user")
			.map((s) => s.id),
		...shownMemory(deps, c, now),
	];
}

/**
 * The memory items a `read_memory` call returned, as `memory:<id>` (the tool's result is text without ids): the
 * same read the tool makes (with the tool's own limit, from the dialogue domain), restricted to the user's items
 * the agent can cite (not the tendencies).
 */
export function readMemoryRefs(
	deps: AgencyHostDeps,
	query: string | undefined,
	now: number,
) {
	const checked = deps.memory.recall({
		text: query ?? "",
		limit: READ_MEMORY_LIMIT,
		shown: new Set(),
		omitShown: true,
		minScore: 0,
	});
	if (!checked) return [];
	const active = new Set(activeMemory(deps, now).map((item) => item.id));
	// A record marked sensitive or about another person is not one a line the agent starts on its own may rest on.
	return checked.items.flatMap((item) =>
		typeof item.id === "string" &&
		!item.sensitive &&
		!item.aboutOther &&
		active.has(item.id)
			? [`memory:${item.id}`]
			: [],
	);
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
	// The agenda's calls are short structured outputs; their thinking level is the saved one, like every call's.
	const inner = deps.createLlm(() => ({
		decisionId: crypto.randomUUID(),
		generation: c.generation,
		conversationId: id,
		independent: true,
		...(cfg.agency.thinkResourceId
			? { resourceId: cfg.agency.thinkResourceId }
			: {}),
	}));
	// A call that began before the user's words, a correction or a forget is stale when it returns.
	const llm: LlmPort = {
		async complete<T>(request: LlmRequest<T>, signal: AbortSignal) {
			const started = c.generation;
			signal.throwIfAborted();
			const diagnostic = c.stepDiagnostic;
			const work = c.stepWork;
			const evidence = [
				diagnostic ? `Eumenes の内部記録（データ）\n${diagnostic.text}` : "",
				work ? `担当の仕事の台帳（データ）\n${work.text}` : "",
			].filter(Boolean);
			const result = await completeBackgroundPlan(
				inner,
				{
					...request,
					system: `${request.system}\n${systemContext("dialogue.contexts.agency.diagnostic-records", {})}`,
					...(evidence.length
						? { prompt: [request.prompt, ...evidence].join("\n\n") }
						: {}),
				},
				signal,
				(research) =>
					!c.researchRefusals.size ||
					deps.store.read(
						(db) =>
							!c.researchRefusals.has(
								prepareResearch(
									deps,
									db,
									citableNotes(c),
									research,
									seenRefs(deps, c, now()),
								).key,
							),
					),
			);
			if (c.generation !== started || signal.aborted)
				throw new DOMException("agenda_stale", "AbortError");
			return result;
		},
	};
	const agent = createAgendaAgent({
		llm,
		known: (call) => {
			const known = knownFor(deps, call, saidOf(c), now());
			for (const item of known) c.shown.add(`memory:${item.id}`);
			for (const old of c.shown) {
				if (c.shown.size <= SHOWN_KEPT) break;
				c.shown.delete(old);
			}
			return known;
		},
		records: (call) => recordsFor(deps, call, saidOf(c)),
		marks: () => marksFor(deps, c),
		notes: () => c.notes.map(noteRef),
		persona: personaOf(deps),
		speechIntervalSec: agendaInterval(cfg.agency.speechIntervalSec),
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
		researchRefusals: new Map(
			(restored?.researchRefusals ?? []).map((r) => [
				r.key,
				structuredClone(r),
			]),
		),
		assignments: new Map(
			(restored?.assignments ?? []).map((a) => [a.itemId, structuredClone(a)]),
		),
		observed: new Map(),
		// The reading position is the conversation's, not the agency's memory: a revoked checkpoint leaves it behind.
		recordsSeq: positionOf(input.previous) ?? takePosition(deps, id),
		closed: new AbortController(),
		recordsRun: null,
		recordsOwed: false,
		forgetSeq: 0,
		renames: new Map(),
		shown: new Set(),
		background: inner,
		finished: new Map(),
		controller: null,
		stepDiagnostic: null,
		stepWork: null,
		workVersion: undefined,
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
		routed: new Map(),
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
