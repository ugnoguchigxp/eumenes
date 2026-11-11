import type { Database } from "bun:sqlite";
import { emotionName, type InputContext } from "eumenes-agency";
import { RESEARCH_TTL_MS, type AgendaTicket } from "eumenes-agency/agenda";
import type { AgendaNote } from "../../domains/dialogue";
import { referencedInput } from "./input";
import { persistSpeech } from "./speech";
import { knownOf, noteRef, type AgendaScope } from "./always-on-scope";
import { toErrorCode } from "../../infrastructure/error-code";
import type { AgencyHostDeps } from "./host-types";

export const workRoot = (c: AgendaScope, ticketId: string) =>
	`agency:${c.scope}:${ticketId}`;

/** Refusals that will not pass by waiting: the research fails (and the user is told), it is not asked again. */
const PERMANENT =
	/^(agency_approval_required|agency_action_budget|agency_capability_unavailable|agency_research_unavailable|agency_execution_unavailable|agency_no_research_capability)$/u;

type ResearchTicket = Extract<AgendaTicket, { kind: "research" }>;
type SpeakTicket = Extract<AgendaTicket, { kind: "speak" }>;

/**
 * The capability a research runs on: the web note toolchain (Codex's own web search), never another one. Without it
 * the research cannot be done (the user's request is not handed to an unrelated capability).
 */
export function researchRevision(
	deps: AgencyHostDeps,
	catalog: ReadonlyArray<{
		revisionId: string;
		requiresApproval: boolean;
		effect?: string | null;
	}>,
): string | undefined {
	if (deps.researchRevision) return deps.researchRevision(catalog);
	return catalog.find(
		(card) =>
			!card.requiresApproval &&
			card.revisionId.startsWith("toolchain:web.note@"),
	)?.revisionId;
}

/** What the model calls of the agent saw: the user's recent words and the memory (conservatively). */
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
		...knownOf(deps, now).map((k) => `memory:${k.id}`),
	];
}

export type ResearchOutcome =
	| { status: "started" }
	| { status: "refused" }
	| { status: "failed"; code: string };

/**
 * Hands one research ticket of the agent to the toolchain: the ticket is saved with the checkpoint first (it is
 * what authorizes the work), then the work is started in the writer. After a restart the same item may come back with
 * a new ticket: the work already running for it is taken over, never started twice.
 */
export async function startResearch(input: {
	deps: AgencyHostDeps;
	c: AgendaScope;
	ticket: ResearchTicket;
	/** The origin is still current (inside the writer). */
	current(db: Database): boolean;
	save(): Promise<boolean>;
	now(): number;
}): Promise<ResearchOutcome> {
	const { deps, c, ticket } = input;
	if (!deps.state)
		return { status: "failed", code: "agency_research_unavailable" };
	if (ticket.delegatedTo)
		return { status: "failed", code: "agency_capability_unavailable" };
	const finished = c.finished.get(ticket.itemId);
	if (finished) {
		c.finished.delete(ticket.itemId);
		c.agent.researchStarted(ticket.id, true, input.now());
		c.agent.researchReturned({
			ticketId: ticket.id,
			at: input.now(),
			status: finished.status,
			note: finished.note ? noteRef(finished.note) : null,
		});
		c.revision++;
		return { status: "started" };
	}
	const taken = c.tickets.find((t) => t.itemId === ticket.itemId);
	if (taken) {
		const active = deps.store.read((db) =>
			deps.state!.workActiveInTransaction(db, workRoot(c, taken.id)),
		);
		if (active) {
			taken.agentTicketId = ticket.id;
			c.agent.researchStarted(ticket.id, true, input.now());
			c.revision++;
			return { status: "started" };
		}
		c.tickets = c.tickets.filter((t) => t !== taken);
	}
	const prepared = deps.store.read((db) => {
		const revisionId = researchRevision(
			deps,
			deps.state!.catalogInTransaction(db),
		);
		return {
			revisionId,
			context: referencedInput(deps, db, c.notes, [
				...ticket.refs,
				...seenRefs(deps, c, input.now()),
			]),
		};
	});
	if (!prepared.revisionId)
		return { status: "failed", code: "agency_no_research_capability" };
	if (!prepared.context.complete) return { status: "refused" };
	const held = {
		id: ticket.id,
		itemId: ticket.itemId,
		agentTicketId: ticket.id,
		revisionId: prepared.revisionId,
		question: ticket.text,
		at: ticket.at,
		refs: [...ticket.refs],
		inputs: [...prepared.context.sources],
	};
	c.tickets.push(held);
	c.revision++;
	try {
		// Another change of the conversation may move the checkpoint meanwhile: save again, at once.
		let saved = false;
		for (let attempt = 0; attempt < 5 && !saved; attempt++)
			saved = await input.save();
		if (!saved) throw new Error("agency_checkpoint_stale");
		await deps.store.write((db) => {
			if (!input.current(db)) throw new Error("agency_origin_stale");
			deps.state!.startInTransaction(db, {
				rootId: workRoot(c, ticket.id),
				conversationId: c.id,
				epoch: c.epoch,
				ticketId: ticket.id,
				revisionId: held.revisionId,
				question: ticket.text,
				// The agent stops waiting for research after this; the work does not outlive it.
				deadline: ticket.at + RESEARCH_TTL_MS,
				sourceRefs: held.inputs,
				// Pacing is the agent's rule; the ledger only fences the epoch (budgets stay in the actions).
				outboundIntervalMs: 0,
			});
		});
		return { status: "started" };
	} catch (error) {
		c.tickets = c.tickets.filter((t) => t !== held);
		c.revision++;
		const code = toErrorCode(error, "agency_research_failed");
		return PERMANENT.test(code)
			? { status: "failed", code }
			: { status: "refused" };
	}
}

/** Speaks one line of the agent: the same message id, Live routing and receipts as every agency utterance. */
export async function deliverSpeak(input: {
	deps: AgencyHostDeps;
	c: AgendaScope;
	ticket: SpeakTicket;
	at: number;
	/** The origin is still current and the user can be spoken to (inside the writer). */
	current(db: Database): boolean;
}): Promise<"appended" | "routed"> {
	const { deps, c, ticket, at } = input;
	const messageId = `agency:${c.scope}:${ticket.id}`;
	return deps.store.write((db) => {
		if (!input.current(db)) throw new Error("agency_origin_stale");
		const context: InputContext = referencedInput(deps, db, c.notes, [
			...ticket.refs,
			...seenRefs(deps, c, at),
		]);
		if (!context.complete) throw new Error("agency_origin_stale");
		// The epoch fence of the record; the gap between utterances is the agent's own pacing.
		if (!deps.state!.claimDispatchInTransaction(db, c.id, c.epoch, at, 0))
			throw new Error("agency_dispatch_interval");
		c.proposals.set(messageId, context);
		for (const old of c.proposals.keys()) {
			if (c.proposals.size <= 16) break;
			c.proposals.delete(old);
		}
		return persistSpeech(deps, db, {
			conversationId: c.id,
			messageId,
			text: ticket.utterance,
			at,
			ticket: {
				findingWorkRefs: findingWorkRefs(c, ticket.refs),
				...(ticket.emotion ? { emotion: emotionName(ticket.emotion) } : {}),
			},
			evidenceRefs: [],
			input: context,
		});
	});
}

/** The work (ticket ids) behind the notes a line cites: the line links to their resources. */
export function findingWorkRefs(c: AgendaScope, refs: readonly string[]) {
	return [
		...new Set(
			refs.flatMap((ref) => {
				const note = ref.startsWith("note:")
					? c.notes.find((n) => n.id === ref.slice("note:".length))
					: undefined;
				return note ? [note.ticketId] : [];
			}),
		),
	];
}

/**
 * Shows a note to the user as a message of the conversation, once the reply that showed it is adopted (the reply's
 * show_note tool). Not an `agency:` message (the web reads those aloud) and not part of what the model is told later:
 * it is a document made of web pages, never the agent's own words, so it is neither recorded as spoken nor learned
 * from. One message per reply and note.
 */
export async function showNote(
	deps: AgencyHostDeps,
	c: AgendaScope,
	note: AgendaNote,
	runId: string,
	at: number,
): Promise<void> {
	const messageId = `agency-note:${c.scope}:${runId}:${note.id}`;
	await deps.store.write((db) => {
		if (
			deps.conversation.sourceInTransaction(db, messageId).state === "available"
		)
			return;
		const context = referencedInput(deps, db, c.notes, [`note:${note.id}`]);
		if (!context.complete) throw new Error("agency_origin_stale");
		deps.conversation.appendInTransaction(db, {
			id: messageId,
			conversationId: c.id,
			role: "assistant",
			text: note.markdown,
			createdAt: new Date(at).toISOString(),
			runId: null,
		});
		deps.memory.blockMessagesInTransaction?.(db, {
			conversationId: c.id,
			messageIds: [messageId],
			reason: "specialist_dialogue",
		});
		deps.memory.referenceInputs?.recordMessageInTransaction(
			db,
			messageId,
			context,
		);
		deps.state?.linkFindingsInTransaction(
			db,
			c.id,
			messageId,
			findingWorkRefs(c, [`note:${note.id}`]),
		);
	});
}
