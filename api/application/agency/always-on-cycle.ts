import type { Database } from "bun:sqlite";
import {
	RESEARCH_RETRY_MS,
	type AgendaTicket,
	type StepOutcome,
} from "eumenes-agency/agenda";
import { getLogger } from "../../infrastructure/logger";
import { toErrorCode } from "../../infrastructure/error-code";
import { currentInput, fixedInput } from "./input";
import { deliverSpeak, startResearch } from "./always-on-flow";
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
};
type ResultHost = Pick<CycleHost, "deps" | "convs" | "now"> & {
	conv(id: string): AgendaScope;
	saveInTransaction(db: Database, patch: Map<string, ScopePatch>): void;
	collected(): void;
};

/** Whether the scope may think and speak now: the active conversation, with nobody typing or being answered. */
export const mayStep = (host: CycleHost, c: AgendaScope) =>
	host.on() &&
	host.convs.get(c.id) === c &&
	c.id === host.active() &&
	!host.busy(c);

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
			const current = (db: Database, speech: boolean) =>
				on() &&
				convs.get(c.id) === c &&
				(!speech ||
					(c.generation === generation &&
						!controller.signal.aborted &&
						digest() === before &&
						fixedInput({
							agency: deps.settings.inTransaction(db).agency,
							general: deps.settings.inTransaction(db).general,
						}).sources[0] === before &&
						deps.conversation.latestOrdinalInTransaction(db, c.id) ===
							ordinal &&
						active() === c.id &&
						!busy(c)));
			for (const ticket of out.tickets)
				await handleTicket(host, c, ticket, current);
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
		c.controller = null;
	}
}

async function handleTicket(
	host: CycleHost,
	c: AgendaScope,
	ticket: AgendaTicket,
	current: (db: Database, speech: boolean) => boolean,
) {
	const { deps, now } = host;
	if (ticket.kind === "research") {
		let outcome: Awaited<ReturnType<typeof startResearch>>;
		try {
			outcome = await startResearch({
				deps,
				c,
				ticket,
				current: (db) => current(db, false),
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
	let delivered = true;
	try {
		// A Live handoff is a proposal the voice session takes; the agent counts it as said.
		await deliverSpeak({
			deps,
			c,
			ticket,
			at: now(),
			current: (db) => current(db, true),
		});
	} catch (error) {
		delivered = false;
		log.warn("agency.delivery_failed", {
			subjectId: c.id,
			reason: toErrorCode(error, "agency_delivery_failed"),
		});
	}
	c.agent.recordDelivery({
		ticketId: ticket.id,
		at: now(),
		status: delivered ? "succeeded" : "failed",
	});
	c.revision++;
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
		if (a.note) a.c.notes = keepNotes([...a.c.notes, a.note]);
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
