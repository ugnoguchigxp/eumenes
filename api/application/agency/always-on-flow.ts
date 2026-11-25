import type { Database } from "bun:sqlite";
import { emotionName, type InputContext } from "eumenes-agency";
import {
	RESEARCH_RETRY_MS,
	RESEARCH_TTL_MS,
	type AgendaTicket,
} from "eumenes-agency/agenda";
import type { AgendaNote, AgendaResearchTicket } from "../../domains/dialogue";
import { currentInput, referencedInput } from "./input";
import { persistSpeech } from "./speech";
import {
	citableNotes,
	noteRef,
	seenRefs,
	type AgendaScope,
} from "./always-on-scope";
import {
	isTransientStoreError,
	toErrorCode,
} from "../../infrastructure/error-code";
import { getLogger } from "../../infrastructure/logger";
import type { AgencyHostDeps } from "./host-types";
import { prepareResearch } from "./research-admission";

export { researchRevision } from "./research-admission";

const log = getLogger("agency");

export const workRoot = (c: AgendaScope, ticketId: string) =>
	`agency:${c.scope}:${ticketId}`;

const RESEARCH_REFUSALS_KEPT = 100;
const RETRYABLE = new Set([
	"agency_checkpoint_stale",
	"agency_dispatch_interval",
]);
const START_REFUSALS = new Set([
	"agency_approval_required",
	"agency_action_budget",
	"agency_capability_unavailable",
	"agency_research_unavailable",
	"agency_execution_unavailable",
	"agency_origin_stale",
	"agency_reference_stale",
	"request_conflict",
]);

type ResearchTicket = Extract<AgendaTicket, { kind: "research" }>;

/** How long work the user asked a toolchain for may run: the longest a toolchain's own run is allowed (two hours). */
export const ASSIGNMENT_TTL_MS = 2 * 60 * 60 * 1000;
type SpeakTicket = Extract<AgendaTicket, { kind: "speak" }>;

export type ResearchOutcome =
	| { status: "started" }
	| { status: "retry"; code: string }
	| { status: "failed"; code: string; refusal?: "recorded" | "repeated" };

function researchReceipt(deps: AgencyHostDeps, c: AgendaScope, id: string) {
	try {
		return deps.store.read((db) =>
			deps.state!.workReceiptInTransaction(db, workRoot(c, id)),
		);
	} catch {
		return "unknown";
	}
}

function markResearchAccepted(
	c: AgendaScope,
	held: AgendaResearchTicket,
	ticket: ResearchTicket,
	now: number,
): ResearchOutcome {
	delete held.pendingAdmission;
	held.agentTicketId = ticket.id;
	c.agent.researchStarted(ticket.id, true, now);
	c.revision++;
	return { status: "started" };
}

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
	// Work the user asked a toolchain for: what it needs to start was kept when the user asked (`delegate`).
	const assignment = ticket.delegatedTo
		? c.assignments.get(ticket.itemId)
		: undefined;
	const taken = c.tickets.find((t) => t.itemId === ticket.itemId);
	const deadline =
		(taken?.at ?? ticket.at) +
		(assignment ? ASSIGNMENT_TTL_MS : RESEARCH_TTL_MS);
	const receipt = taken ? researchReceipt(deps, c, taken.id) : "missing";
	if (taken && receipt === "accepted")
		return markResearchAccepted(c, taken, ticket, input.now());
	if (receipt === "unknown" && input.now() + RESEARCH_RETRY_MS < deadline)
		return { status: "retry", code: "agency_research_receipt_unavailable" };
	const item = c.agent
		.view()
		.items.find((candidate) => candidate.id === ticket.itemId);
	const prepared = deps.store.read((db) =>
		prepareResearch(
			deps,
			db,
			citableNotes(c),
			{ ...ticket, text: item?.text ?? ticket.text },
			seenRefs(deps, c, input.now()),
			assignment?.revisionId,
		),
	);
	const discard = (held: AgendaResearchTicket | undefined) => {
		if (!held) return;
		c.tickets = c.tickets.filter((t) => t !== held);
		c.revision++;
	};
	const fail = (code: string, held = taken): ResearchOutcome => {
		discard(held);
		c.researchRefusals.set(prepared.key, {
			key: prepared.key,
			code,
			sources: prepared.context.complete ? prepared.context.sources : [],
		});
		while (c.researchRefusals.size > RESEARCH_REFUSALS_KEPT)
			c.researchRefusals.delete(c.researchRefusals.keys().next().value!);
		return { status: "failed", code, refusal: "recorded" };
	};
	const previous = c.researchRefusals.get(prepared.key);
	if (previous) {
		discard(taken);
		return { status: "failed", code: previous.code, refusal: "repeated" };
	}
	if (receipt === "unknown") return fail("agency_research_receipt_unavailable");
	if (taken && (receipt === "closed" || !taken.pendingAdmission))
		return fail("agency_origin_stale");
	if (ticket.delegatedTo && !assignment)
		return fail("agency_capability_unavailable");
	if (!prepared.revisionId)
		return fail(
			assignment
				? "agency_capability_unavailable"
				: "agency_no_research_capability",
		);
	if (prepared.reason) return fail(prepared.reason);
	if (input.now() >= deadline) return fail("agency_research_admission_expired");
	if (taken && taken.revisionId !== prepared.revisionId) {
		discard(taken);
		return { status: "failed", code: "agency_capability_unavailable" };
	}
	const held: AgendaResearchTicket = taken ?? {
		id: ticket.id,
		itemId: ticket.itemId,
		agentTicketId: ticket.id,
		revisionId: prepared.revisionId,
		question: ticket.text,
		at: ticket.at,
		refs: [...ticket.refs],
		inputs: [...prepared.context.sources],
		pendingAdmission: true,
		...(assignment
			? {
					assignment: true as const,
					references: structuredClone(assignment.references),
					...(assignment.details
						? { details: structuredClone(assignment.details) }
						: {}),
				}
			: {}),
	};
	if (!taken) c.tickets.push(held);
	held.agentTicketId = ticket.id;
	c.revision++;
	try {
		// Another change of the conversation may move the checkpoint meanwhile: save again, at once.
		let saved = false;
		for (let attempt = 0; attempt < 5 && !saved; attempt++)
			saved = await input.save();
		if (!saved) throw new Error("agency_checkpoint_stale");
		await deps.store.write((db) => {
			if (!input.current(db) || !c.tickets.includes(held))
				throw new Error("agency_origin_stale");
			if (!currentInput(deps, db, { sources: held.inputs, complete: true }))
				throw new Error("agency_reference_stale");
			deps.state!.startInTransaction(db, {
				rootId: workRoot(c, held.id),
				conversationId: c.id,
				epoch: c.epoch,
				ticketId: held.id,
				revisionId: held.revisionId,
				question: held.question,
				// The agent stops waiting for research after this; the work does not outlive it. An assignment runs as
				// long as its toolchain allows (the owner ends it and reports the end).
				deadline,
				...(assignment
					? {
							assignment: true,
							references: held.references ?? [],
							source: assignment.source,
							...(held.details ? { details: held.details } : {}),
						}
					: {}),
				sourceRefs: held.inputs,
				// Pacing is the agent's rule; the ledger only fences the epoch (budgets stay in the actions).
				outboundIntervalMs: 0,
			});
		});
		return markResearchAccepted(c, held, ticket, input.now());
	} catch (error) {
		const code = toErrorCode(error, "agency_research_failed");
		if (code === "request_conflict") return fail(code, held);
		const receipt = researchReceipt(deps, c, held.id);
		if (receipt === "accepted")
			return markResearchAccepted(c, held, ticket, input.now());
		let retry: string | undefined;
		if (receipt === "unknown") retry = "agency_research_receipt_unavailable";
		if (receipt === "missing") {
			if (isTransientStoreError(error)) retry = "agency_store_busy";
			else if (RETRYABLE.has(code)) retry = code;
		}
		if (retry) {
			if (input.now() + RESEARCH_RETRY_MS < deadline)
				return { status: "retry", code: retry };
			return fail("agency_research_admission_expired", held);
		}
		return fail(
			START_REFUSALS.has(code) ? code : "agency_research_failed",
			held,
		);
	}
}

/** The user began to type, to speak or to be read to in the instant before a line was stored: the line is held. */
export const SPEECH_BUSY = "agency_busy";

/** The message of a line the agent says on its own. */
export const speechId = (c: AgendaScope, ticketId: string) =>
	`agency:${c.scope}:${ticketId}`;

/** Speaks one line of the agent: the same message id, Live routing and receipts as every agency utterance. */
export async function deliverSpeak(input: {
	deps: AgencyHostDeps;
	c: AgendaScope;
	ticket: SpeakTicket;
	at: number;
	/**
	 * Inside the writer: the origin is still current (`stale` when not), and the user can be spoken to (`busy` while
	 * they type, are answered or are read to).
	 */
	current(db: Database): "ok" | "stale" | "busy";
}): Promise<"appended" | "routed"> {
	const { deps, c, ticket, at } = input;
	const messageId = speechId(c, ticket.id);
	return deps.store.write((db) => {
		const state = input.current(db);
		if (state === "busy") throw new Error(SPEECH_BUSY);
		if (state !== "ok") throw new Error("agency_origin_stale");
		const context: InputContext = referencedInput(deps, db, citableNotes(c), [
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
 * Keeps a note as a Markdown document from the moment the scope holds it (a research came back, or a restart brought
 * the note back): the documents pile up in the document library, so a note the agent's own list lets go later is
 * still there to read. The same note is the same document, so asking again saves nothing twice. A note that cannot
 * be saved stays the agent's note all the same.
 */
export function keepNote(
	deps: AgencyHostDeps,
	c: AgendaScope,
	note: AgendaNote,
): Promise<void> {
	const documents = deps.noteDocuments;
	if (!documents) return Promise.resolve();
	return deps.store
		.write((db) => {
			// Forgotten meanwhile: no document is made of it.
			if (!citableNotes(c).some((n) => n.id === note.id)) return;
			startNoteDocument(deps, db, c.id, note);
		})
		.catch((error: unknown) => {
			log.warn("agency.note_document_failed", {
				subjectId: c.id,
				reason: toErrorCode(error, "note_document_failed"),
			});
		});
}

/** Reattaching a saved note must use its original, never its checkpoint preview. */
export function startNoteDocument(
	deps: AgencyHostDeps,
	db: Database,
	conversationId: string,
	note: AgendaNote,
) {
	const documents = deps.noteDocuments;
	if (!documents) throw new Error("agency_note_documents_unavailable");
	const original = note.documentId
		? documents.readInTransaction(db, note.documentId)
		: note;
	if (!original) throw new Error("markdown_not_found");
	return documents.startInTransaction(db, {
		conversationId,
		noteId: note.id,
		title: original.title,
		markdown: original.markdown,
		at: note.at,
	});
}

/** How long the saving of a note's document is waited for (the Markdown domain gives its job 200 s). */
const NOTE_DOCUMENT_WAIT_MS = 210_000;
const NOTE_DOCUMENT_POLL_MS = 500;

/**
 * Waits for the Markdown document, then returns the write that puts its chip on a message of the adopted reply.
 * The message carries the title and summary and is kept out of speech, the model's history and Memory learning.
 * Each reply can publish a given note once.
 */
export async function prepareNoteDisplay(
	deps: AgencyHostDeps,
	host: {
		now(): number;
		setTimer(fn: () => void, ms: number): unknown;
		clearTimer(handle: unknown): void;
		goalNoteInTransaction:
			| ((
					db: Database,
					id: string,
			  ) => (AgendaNote & { documentConversationId: string }) | undefined)
			| undefined;
	},
	c: AgendaScope,
	note: AgendaNote,
	runId: string,
	replySignal?: AbortSignal,
): Promise<(db: Database) => void> {
	const documents = deps.noteDocuments;
	if (!documents) throw new Error("agency_note_documents_unavailable");
	const signal = replySignal
		? AbortSignal.any([c.closed.signal, replySignal])
		: c.closed.signal;
	const messageId = `agency-note:${c.scope}:${runId}:${note.id}`;
	const shown = (db: Database) =>
		deps.conversation.sourceInTransaction(db, messageId).state === "available";
	const origin = (db: Database) => {
		const notes = citableNotes(c);
		const design = host.goalNoteInTransaction?.(db, note.id);
		if (design) notes.push(design);
		const context = referencedInput(deps, db, notes, [`note:${note.id}`]);
		if (!context.complete) throw new Error("agency_origin_stale");
		return { context, design };
	};
	const id = await deps.store.write((db) => {
		signal.throwIfAborted();
		if (shown(db)) return null;
		const { design } = origin(db);
		return startNoteDocument(
			deps,
			db,
			design?.documentConversationId ?? c.id,
			design ?? note,
		);
	});
	if (id === null) return () => {};
	const until = host.now() + NOTE_DOCUMENT_WAIT_MS;
	let state = deps.store.read((db) => documents.stateInTransaction(db, id));
	while (state === "pending") {
		if (signal.aborted) throw new Error("agency_scope_closed");
		if (host.now() >= until) throw new Error("agency_note_document_timeout");
		await new Promise<void>((resolve) => {
			const done = () => {
				host.clearTimer(timer);
				signal.removeEventListener("abort", done);
				resolve();
			};
			const timer = host.setTimer(done, NOTE_DOCUMENT_POLL_MS);
			signal.addEventListener("abort", done, { once: true });
		});
		state = deps.store.read((db) => documents.stateInTransaction(db, id));
	}
	if ("code" in state) throw new Error(state.code);
	return (db) => {
		signal.throwIfAborted();
		if (shown(db)) return;
		const { context } = origin(db);
		const document = documents.stateInTransaction(db, id);
		if (document === "pending") throw new Error("agency_note_document_pending");
		if ("code" in document) throw new Error(document.code);
		deps.conversation.appendInTransaction(db, {
			id: messageId,
			conversationId: c.id,
			role: "assistant",
			text: [note.title, note.summary].filter(Boolean).join("\n"),
			createdAt: new Date(host.now()).toISOString(),
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
		documents.linkInTransaction(db, {
			conversationId: c.id,
			messageId,
			uri: document.uri,
			label: document.label,
		});
	};
}

export function logNoteDisplayFailure(conversationId: string, error: unknown) {
	log.warn("agency.show_note_failed", {
		subjectId: conversationId,
		reason: toErrorCode(error, "show_note_failed"),
	});
}
