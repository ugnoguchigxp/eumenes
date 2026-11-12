import type { Database } from "bun:sqlite";
import {
	RESEARCH_RETRY_MS,
	type AgendaTicket,
	type StepOutcome,
} from "eumenes-agency/agenda";
import { getLogger } from "../../infrastructure/logger";
import { toErrorCode } from "../../infrastructure/error-code";
import { currentInput, fixedInput } from "./input";
import {
	deliverSpeak,
	keepNote,
	speechId,
	SPEECH_BUSY,
	startResearch,
} from "./always-on-flow";
import type { AgendaHearing } from "./always-on-heard";
import { keepNotes, noteFromResult } from "./always-on-memory";
import { noteRef, type AgendaScope } from "./always-on-scope";
import type { ScopePatch } from "./always-on-checkpoint";
import type { AgendaNote } from "../../domains/dialogue";
import type { AgencyHostDeps } from "./host-types";

const log = getLogger("agency");

type CycleHost = {
	deps: AgencyHostDeps;
	convs: Map<string, AgendaScope>;
	on(): boolean;
	now(): number;
	busy(c: AgendaScope): boolean;
	digest(): string;
	save(): Promise<boolean>;
	active(): string | null;
	refresh(c: AgendaScope): Promise<void>;
	hearing: AgendaHearing;
	/** Resolves when the user of the scope is free again (true), or the scope or the host is gone (false). */
	idle(c: AgendaScope): Promise<boolean>;
};
type ResultHost = Pick<CycleHost, "deps" | "convs" | "now"> & {
	conv(id: string): AgendaScope;
	saveInTransaction(db: Database, patch: Map<string, ScopePatch>): void;
	collected(): void;
};

/**
 * The research that waits to start (none while one runs). It starts even while the user types, is answered or
 * listens: the agent holds its plan and its own words itself then, and what was asked for does not wait for a pause.
 */
export function researchWaiting(c: AgendaScope) {
	const view = c.agent.view();
	return view.researching
		? ""
		: view.items
				.filter((i) => i.kind === "research" && i.status === "open")
				.map((i) => i.id)
				.join(" ");
}

/**
 * Whether a step of the scope has something to do now: the active conversation, and either nobody typing or being
 * answered, or research that waits and was not tried yet while they are (one step for each set of waiting research:
 * what that step could not start waits for the pause).
 */
export function mayStep(host: CycleHost, c: AgendaScope) {
	if (!host.on() || host.convs.get(c.id) !== c || c.id !== host.active())
		return false;
	if (!host.busy(c)) return true;
	const waiting = researchWaiting(c);
	return waiting !== "" && waiting !== c.triedWhileBusy;
}

const logCalls = (c: AgendaScope, out: StepOutcome) => {
	for (const call of [
		out.plan?.call,
		out.check?.call,
		out.compose?.call,
	].filter((x) => x !== undefined))
		log.info("agency.llm_call", {
			subjectId: c.id,
			purpose: "think",
			outcome: call.code,
			durationMs: call.latencyMs,
			promptTokens: call.inputTokens,
			completionTokens: call.outputTokens,
		});
};

/**
 * One step of the agenda agent now (or right after the one running): the agent plans, starts research and picks what
 * to say as its rules allow; the host hands its tickets over. Resolves when the tickets are handled and saved.
 */
export async function runAgendaStep(host: CycleHost, c: AgendaScope) {
	const { deps, convs, on, now, busy, digest, active } = host;
	if (c.stepping) {
		c.again = true;
		return;
	}
	c.stepping = true;
	let signal: AbortSignal | undefined;
	try {
		do {
			c.again = false;
			if (!mayStep(host, c)) break;
			await host.refresh(c);
			if (!mayStep(host, c)) break;
			const generation = c.generation;
			const ordinal = deps.store.read((db) =>
				deps.conversation.latestOrdinalInTransaction(db, c.id),
			);
			const before = digest();
			const controller = new AbortController();
			c.triedWhileBusy = busy(c) ? researchWaiting(c) : "";
			signal = controller.signal;
			c.controller = controller;
			c.revision++;
			let out: StepOutcome;
			try {
				out = await c.agent.step(
					now(),
					() => ({ busy: busy(c) || c.id !== active() || !on() }),
					controller.signal,
				);
			} finally {
				if (c.controller === controller) c.controller = null;
			}
			c.revision++;
			logCalls(c, out);
			const current = () => on() && convs.get(c.id) === c;
			// A line is for the conversation as the step saw it; a user who is busy only delays it.
			const speech = (db: Database) =>
				!current() ||
				c.generation !== generation ||
				controller.signal.aborted ||
				digest() !== before ||
				fixedInput({
					agency: deps.settings.inTransaction(db).agency,
					general: deps.settings.inTransaction(db).general,
				}).sources[0] !== before ||
				deps.conversation.latestOrdinalInTransaction(db, c.id) !== ordinal ||
				active() !== c.id
					? "stale"
					: busy(c)
						? "busy"
						: "ok";
			for (const ticket of out.tickets)
				await handleTicket(host, c, ticket, current, speech);
			c.revision++;
			await host.save().catch((error) =>
				log.warn("agency.checkpoint_failed", {
					reason: toErrorCode(error, "checkpoint_failed"),
				}),
			);
		} while (c.again && convs.get(c.id) === c);
	} catch (error) {
		// Called off (the user spoke, a forget): the next step follows at once. A failing step waits a little.
		if (!signal?.aborted) {
			c.backoffUntil = now() + RESEARCH_RETRY_MS;
			log.warn("agency.cycle_failed", {
				subjectId: c.id,
				reason: toErrorCode(error, "agency_cycle_failed"),
			});
		}
	} finally {
		c.stepping = false;
		// A step called off started nothing: the research that waited is tried again.
		if (signal?.aborted) c.triedWhileBusy = "";
		c.controller = null;
	}
}

async function handleTicket(
	host: CycleHost,
	c: AgendaScope,
	ticket: AgendaTicket,
	current: () => boolean,
	speech: (db: Database) => "ok" | "stale" | "busy",
) {
	const { deps, now } = host;
	if (ticket.kind === "research") {
		let outcome: Awaited<ReturnType<typeof startResearch>>;
		try {
			outcome = await startResearch({
				deps,
				c,
				ticket,
				current,
				save: host.save,
				now,
			});
		} catch (error) {
			log.warn("agency.research_failed", {
				subjectId: c.id,
				reason: toErrorCode(error, "agency_research_failed"),
			});
			outcome = { status: "refused" };
		}
		if (outcome.status === "refused")
			c.agent.researchStarted(ticket.id, false, now());
		else if (outcome.status === "failed") {
			log.info("agency.research_unavailable", {
				subjectId: c.id,
				reason: outcome.code,
			});
			c.agent.researchStarted(ticket.id, true, now());
			c.agent.researchReturned({
				ticketId: ticket.id,
				at: now(),
				status: "failed",
				note: null,
			});
		}
		c.revision++;
		return;
	}
	let deliveredAt: number | null = null;
	for (;;) {
		const at = now();
		try {
			// A Live handoff is a proposal the voice session takes; the agent counts it as said.
			await deliverSpeak({ deps, c, ticket, at, current: speech });
			deliveredAt = at;
			break;
		} catch (error) {
			const reason = toErrorCode(error, "agency_delivery_failed");
			// The user began to type or to be answered in the instant before the line was stored: the line is held
			// to the end of that, as the agent holds a line it wrote ahead, and not said if they spoke meanwhile.
			if (reason === SPEECH_BUSY && (await host.idle(c))) continue;
			log.warn("agency.delivery_failed", { subjectId: c.id, reason });
			break;
		}
	}
	c.revision++;
	if (deliveredAt === null) {
		c.agent.recordDelivery({
			ticketId: ticket.id,
			at: now(),
			status: "failed",
		});
		return;
	}
	// The line is said when the user has heard it: the agent's gaps run from the end of the reading.
	host.hearing.appeared(
		c,
		{ id: speechId(c, ticket.id), at: deliveredAt, own: true },
		(saidAt) => {
			c.agent.recordDelivery({
				ticketId: ticket.id,
				at: saidAt,
				status: "succeeded",
			});
			c.revision++;
		},
	);
}

/**
 * Results of the work the agent started come back through the ledger: each is adopted once (the ledger releases
 * its authority), becomes a note, and is told to the agent. A result whose origin was forgotten is discarded.
 */
export async function collectAgendaResults(host: ResultHost) {
	const { deps, now, conv, saveInTransaction, collected } = host;
	if (!deps.state) return;
	const results = deps.store.read((db) => deps.state!.resultsInTransaction(db));
	if (!results.length) return;
	type Adopted = {
		c: AgendaScope;
		ticketId: string;
		agentTicketId: string;
		itemId: string;
		status: "succeeded" | "failed";
		note: AgendaNote | null;
	};
	const adopted: Adopted[] = [];
	const patch = new Map<string, ScopePatch>();
	await deps.store.write((db) => {
		adopted.length = 0;
		patch.clear();
		for (const r of deps.state!.resultsInTransaction(db)) {
			const c = conv(r.conversationId);
			if (c.epoch !== r.epoch) continue;
			const patchOf = () => {
				let p = patch.get(c.id);
				if (!p) {
					p = { tickets: [...c.tickets], notes: [...c.notes] };
					patch.set(c.id, p);
				}
				return p;
			};
			const ticket = c.tickets.find((t) => t.id === r.ticketId);
			if (
				!ticket ||
				!currentInput(deps, db, { sources: ticket.inputs, complete: true })
			) {
				deps.state!.cancelInTransaction(db, r.rootId);
				deps.state!.returnedInTransaction(db, r.rootId);
				if (ticket) {
					const p = patchOf();
					p.tickets = p.tickets.filter((t) => t.id !== ticket.id);
				}
				continue;
			}
			if (r.cancel) deps.state!.cancelInTransaction(db, r.rootId);
			const taken = deps.state!.returnedInTransaction(db, r.rootId);
			const done =
				taken && (r.workStatus === "succeeded" || r.workStatus === "partial");
			// A result with nothing usable in it is a failure, not "done".
			const note = done
				? noteFromResult({
						id: `n${crypto.randomUUID().slice(0, 8)}`,
						ticket,
						summary: r.summary,
						at: now(),
					})
				: null;
			const good = note !== null;
			const p = patchOf();
			p.tickets = p.tickets.filter((t) => t.id !== ticket.id);
			if (note) p.notes = keepNotes([...p.notes, note]);
			adopted.push({
				c,
				ticketId: ticket.id,
				agentTicketId: ticket.agentTicketId,
				itemId: ticket.itemId,
				status: good ? "succeeded" : "failed",
				note,
			});
		}
		if (patch.size) saveInTransaction(db, patch);
	});
	// Committed: the volatile state follows (a rolled-back write above leaves the scopes as they were).
	for (const a of adopted) {
		a.c.tickets = a.c.tickets.filter((t) => t.id !== a.ticketId);
	const kept: Promise<void>[] = [];
		if (a.note) {
			a.c.notes = keepNotes([...a.c.notes, a.note]);
			kept.push(keepNote(deps, a.c, a.note));
		}
		const at = now();
		a.c.agent.researchReturned({
			ticketId: a.agentTicketId,
			at,
			status: a.status,
			note: a.note ? noteRef(a.note) : null,
		});
		// A ticket the running agent does not know (a restart took its item) leaves the item waiting: the
		// agent asks again, and the result is told then.
		const waiting = a.c.agent
			.view()
			.items.find((i) => i.id === a.itemId && i.status === "open");
		if (waiting) a.c.finished.set(a.itemId, { status: a.status, note: a.note });
		a.c.revision++;
		a.c.kick();
	}
	collected();
}
	// Each note is kept as a Markdown document from here on.
	await Promise.all(kept);
