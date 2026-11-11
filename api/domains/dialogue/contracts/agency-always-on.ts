import { z } from "zod";
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
};

/** A result of the researcher, kept for the agent to read (the host's note store of the conversation). */
export type AgendaNote = {
	id: string;
	title: string;
	summary: string;
	markdown: string;
	at: number;
	refs: string[];
	/** The work it came from (the ticket id of the start). */
	ticketId: string;
};

/**
 * The user's plans-and-interests note (Markdown, the package's profile): written from what the user said, for what the
 * memory leaves out. `passes` keep each writer pass's result and the user's words it read, so forgetting those words
 * takes the note back to before them (`base` is the note before the oldest kept pass).
 */
export type AgendaProfile = {
	markdown: string;
	base: string;
	passes: Array<{ markdown: string; sources: string[] }>;
};

/** Writer passes kept (older ones are folded into `base`). */
export const PROFILE_PASSES_KEPT = 12;

/** Host-owned envelope of one conversation's agenda agent. */
export type AgendaHostSnapshot = {
	kind: "agenda";
	version: 1;
	revision: number;
	agent: AgendaSnapshot;
	tickets: AgendaResearchTicket[];
	notes: AgendaNote[];
	profile?: AgendaProfile;
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
		}),
	),
	profile: z
		.strictObject({
			markdown: z.string(),
			base: z.string(),
			passes: z.array(
				z.strictObject({ markdown: z.string(), sources: strings }),
			),
		})
		.optional(),
	notes: z.array(
		z.strictObject({
			id: z.string().min(1),
			title: z.string(),
			summary: z.string(),
			markdown: z.string(),
			at: z.number(),
			refs: strings,
			ticketId: z.string(),
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
			...value.notes.flatMap((n) => n.refs.map(baseRef)),
			...(value.profile?.passes.flatMap((p) => p.sources) ?? []),
		]),
	];
}

/** The input a research ticket was started with; it authorizes the work (never a forged ticket). */
export function agendaTicketInput(snapshot: AgendaHostSnapshot, id: string) {
	const ticket = snapshot.tickets.find((t) => t.id === id);
	return ticket ? { sources: ticket.inputs, complete: true } : null;
}

/**
 * The note after forgetting `refs`: back to before the first pass that read a forgotten message (what later passes
 * added is lost with it: they were written over the earlier note).
 */
export function forgetProfile(
	profile: AgendaProfile | undefined,
	refs: ReadonlySet<string>,
): AgendaProfile | undefined {
	if (!profile) return profile;
	const at = profile.passes.findIndex((pass) =>
		pass.sources.some((id) => refs.has(id) || refs.has(baseRef(id))),
	);
	if (at < 0) return profile;
	return {
		markdown: at === 0 ? profile.base : profile.passes[at - 1]!.markdown,
		base: profile.base,
		passes: profile.passes.slice(0, at),
	};
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
		value.notes.filter((n) => gone(n.refs)).map((n) => `note:${n.id}`),
	);
	const items = value.agent.items.filter(
		(i) => !gone(i.refs) && !i.refs.some((r) => lost.has(r)),
	);
	return {
		...value,
		revision: value.revision + 1,
		agent: { ...value.agent, items },
		tickets: value.tickets.filter(
			(t) =>
				!gone([...t.refs, ...t.inputs]) && !t.refs.some((r) => lost.has(r)),
		),
		notes: value.notes.filter((n) => !gone(n.refs)),
		...(value.profile
			? { profile: forgetProfile(value.profile, refs) as AgendaProfile }
			: {}),
	};
}
