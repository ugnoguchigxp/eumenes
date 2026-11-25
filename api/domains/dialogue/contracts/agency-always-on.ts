import { z } from "zod";
import {
	executionReference,
	type ExecutionReference,
	type RoutedPipelineStep,
} from "../../tool-runtime";

/**
 * The fields of a `delegate` call besides its request and refs, carried as they were given: the start uses what the
 * conversation's dispatch used (routed steps for a pipeline), and the ticket is checked to still hold them.
 */
export type AssignmentDetails = {
	inputs?: Record<string, unknown>;
	target?: string;
	diagnosticRef?: string;
	resolveUnsaved?: "discard";
	routedSteps?: RoutedPipelineStep[];
};

const assignmentDetails = z.strictObject({
	inputs: z.record(z.string(), z.unknown()).optional(),
	target: z.string().min(1).optional(),
	diagnosticRef: z
		.string()
		.regex(/^e[1-9]\d{0,12}$/u)
		.optional(),
	resolveUnsaved: z.literal("discard").optional(),
	routedSteps: z
		.array(
			z.strictObject({
				text: z.string(),
				entry: z.string(),
				revisionId: z.string().min(1),
				after: z.array(z.number().int().nonnegative()),
			}),
		)
		.max(16)
		.optional(),
});
import {
	agendaSnapshotSchema,
	type AgendaSnapshot,
} from "eumenes-agency/agenda";

/**
 * The always-on runtime is the agenda agent (eumenes-agency/agenda): code keeps the list of things to do, the model
 * reads words and writes content. What outlives a restart is what was promised and not finished (research asked for
 * or promised, results not told yet) and the quiet the user asked for, plus the host's own bookkeeping: the research
 * it handed to the toolchains, and the notes (the results it adopted). Pending speech is never replayed.
 */

/** A research handed to a toolchain: the ledger row `dialogue_agency_work` is keyed by `id` (the ticket id of the start). */
export type AgendaResearchTicket = {
	/** The ticket the work was started with (the work row's `ticket_id`). */
	id: string;
	/** The agent's item it serves; a ticket made after a restart for the same item takes over this work. */
	itemId: string;
	/** The ticket the agent waits on now (differs from `id` after a restart). */
	agentTicketId: string;
	revisionId: string;
	question: string;
	at: number;
	/** What it rests on, as the agent cites it: message ids, `memory:<id>`, `note:<id>`. */
	refs: string[];
	/** The sources of those references (Memory stamps) captured when it started. */
	inputs: string[];
	/** The operation was checkpointed and its acceptance still needs to be reconciled. */
	pendingAdmission?: true;
	/** Work the user asked a toolchain for (`delegate`): started with the user's request as its authority. */
	assignment?: true;
	/** The resources the request names (an assignment's `delegate` refs), handed to the toolchain as they were. */
	references?: ExecutionReference[];
	/** An assignment's other `delegate` fields, as they were given. */
	details?: AssignmentDetails;
};

/**
 * What the user asked a toolchain for through `delegate`, kept by the agent's item id until the item is started: the
 * agent holds the item (its request, status, question and result), the host what the toolchain needs to start it.
 */
export type AgendaAssignment = {
	itemId: string;
	toolchainId: string;
	revisionId: string;
	/** The toolchain's name as the agent says it (`delegatedTo`). */
	title: string;
	references: ExecutionReference[];
	/** The user's words the request was made in: the toolchain takes the work as the user's, not the agency's. */
	source: AssignmentSource;
	details?: AssignmentDetails;
};

/** The user-message source of an assignment (a standard execution source without host-issued extras). */
export type AssignmentSource = {
	conversationId: string;
	messageId: string;
	runId: string;
	request: string;
	digest: string;
};

/** A result of the researcher, kept for the agent to read (the host's note store of the conversation). */
export type AgendaNote = {
	id: string;
	title: string;
	summary: string;
	markdown: string;
	/** The generated document holds the full body; markdown above is only a checkpoint preview when present. */
	documentId?: string;
	at: number;
	refs: string[];
	/** The work it came from (the ticket id of the start). */
	ticketId: string;
	/** The verified source versions of that work, retained even when a parent note leaves the list. */
	inputs?: string[];
};

/** Host-owned envelope of one conversation's agenda agent. */
export type AgendaHostSnapshot = {
	kind: "agenda";
	version: 1;
	revision: number;
	agent: AgendaSnapshot;
	tickets: AgendaResearchTicket[];
	notes: AgendaNote[];
	researchRefusals?: AgendaResearchRefusal[];
	/** Absent in a checkpoint written before assignments were held. */
	assignments?: AgendaAssignment[];
};

export type AgendaResearchRefusal = {
	key: string;
	code: string;
	sources: string[];
};

const strings = z.array(z.string());
const snapshotSchema = z.strictObject({
	kind: z.literal("agenda"),
	version: z.literal(1),
	revision: z.number().int().nonnegative(),
	agent: agendaSnapshotSchema,
	tickets: z.array(
		z.strictObject({
			id: z.string().min(1),
			itemId: z.string().min(1),
			agentTicketId: z.string().min(1),
			revisionId: z.string().min(1),
			question: z.string(),
			at: z.number(),
			refs: strings,
			inputs: strings,
			pendingAdmission: z.literal(true).optional(),
			assignment: z.literal(true).optional(),
			references: z.array(executionReference).optional(),
			details: assignmentDetails.optional(),
		}),
	),
	researchRefusals: z
		.array(
			z.strictObject({ key: z.string(), code: z.string(), sources: strings }),
		)
		.optional(),
	assignments: z
		.array(
			z.strictObject({
				itemId: z.string().min(1),
				toolchainId: z.string().min(1),
				revisionId: z.string().min(1),
				title: z.string().min(1),
				references: z.array(executionReference),
				source: z.strictObject({
					conversationId: z.string().min(1),
					messageId: z.string().min(1),
					runId: z.string().min(1),
					request: z.string(),
					digest: z.string().min(1),
				}),
				details: assignmentDetails.optional(),
			}),
		)
		.optional(),
	// A checkpoint written before the plans-and-interests note was retired carries it: read and dropped.
	profile: z.unknown().optional(),
	notes: z.array(
		z.strictObject({
			id: z.string().min(1),
			title: z.string(),
			summary: z.string(),
			markdown: z.string(),
			documentId: z.string().min(1).optional(),
			at: z.number(),
			refs: strings,
			ticketId: z.string(),
			inputs: strings.optional(),
		}),
	),
});

export function isAgendaSnapshot(value: unknown): value is AgendaHostSnapshot {
	return snapshotSchema.safeParse(value).success;
}

/** Message ids refer to the user's lines; a corrected line is `<id>:c<seq>` for the agent. */
export const baseRef = (ref: string) => ref.replace(/:c\d+$/u, "");

/** Every reference the checkpoint rests on (dependency registration and forgetting reach). */
export function agendaSources(value: AgendaHostSnapshot): string[] {
	return [
		...new Set([
			...value.agent.items.flatMap((i) => i.refs.map(baseRef)),
			...value.tickets.flatMap((t) => [...t.refs.map(baseRef), ...t.inputs]),
			...(value.researchRefusals ?? []).flatMap((r) => r.sources.map(baseRef)),
			...value.notes.flatMap((n) => [
				...n.refs.map(baseRef),
				...(n.inputs ?? []),
			]),
			...(value.assignments ?? []).map((a) => a.source.messageId),
		]),
	];
}

/** The input a research ticket was started with; it authorizes the work (never a forged ticket). */
export function agendaTicketInput(snapshot: AgendaHostSnapshot, id: string) {
	const ticket = snapshot.tickets.find((t) => t.id === id);
	return ticket ? { sources: ticket.inputs, complete: true } : null;
}

/**
 * What forgetting `refs` leaves of a checkpoint: items, tickets and notes that rest on them are gone. The same rule
 * the running agent applies (`AgendaAgent.forget`), for a record no agent holds.
 */
export function forgetAgenda(
	value: AgendaHostSnapshot,
	refs: ReadonlySet<string>,
): AgendaHostSnapshot {
	const gone = (list: readonly string[]) =>
		list.some((ref) => refs.has(ref) || refs.has(baseRef(ref)));
	const lost = new Set(
		value.notes
			.filter((n) => gone([...n.refs, ...(n.inputs ?? [])]))
			.map((n) => `note:${n.id}`),
	);
	const tickets = value.tickets.filter(
		(t) => !gone([...t.refs, ...t.inputs]) && !t.refs.some((r) => lost.has(r)),
	);
	const retained = new Set(tickets.map((ticket) => ticket.id));
	const lostItems = new Set(
		value.tickets
			.filter((ticket) => !retained.has(ticket.id))
			.map((ticket) => ticket.itemId),
	);
	const items = value.agent.items.filter(
		(i) =>
			!lostItems.has(i.id) && !gone(i.refs) && !i.refs.some((r) => lost.has(r)),
	);
	// A checkpoint written before the note was retired still holds it: it is not carried on.
	const { profile: _retired, ...rest } = value as AgendaHostSnapshot & {
		profile?: unknown;
	};
	return {
		...rest,
		revision: value.revision + 1,
		agent: { ...value.agent, items },
		tickets,
		...(value.researchRefusals
			? {
					researchRefusals: value.researchRefusals.filter(
						(r) => !gone(r.sources),
					),
				}
			: {}),
		notes: value.notes.filter((n) => !lost.has(`note:${n.id}`)),
		// An assignment goes with its item, and with the user's words it was asked in.
		...(value.assignments
			? {
					assignments: value.assignments.filter(
						(a) =>
							items.some((i) => i.id === a.itemId) &&
							!gone([a.source.messageId]),
					),
				}
			: {}),
	};
}
