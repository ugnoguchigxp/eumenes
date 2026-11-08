import { z } from "zod";
import type {
	AlwaysOnSnapshot,
	AlwaysOnTicket,
	InputContext,
} from "eumenes-agency";

/** Host-owned envelope. Pending speech is never replayed; tickets certify real effects and returns. */
export type AlwaysOnHostSnapshot = {
	kind: "always-on";
	version: 1;
	revision: number;
	agent: AlwaysOnSnapshot;
	tickets: AlwaysOnTicket[];
	memoryObservations?: true;
};

const strings = z.array(z.string());
const count = z.number().int().nonnegative();
const timed = z.object({ at: z.number(), inputs: strings });
const derived = timed.extend({ id: z.string() });
const snapshotSchema = z.object({
	kind: z.literal("always-on"),
	version: z.literal(1),
	revision: count,
	memoryObservations: z.literal(true).optional(),
	tickets: z.array(
		timed.extend({
			id: z.string(),
			tickId: z.string(),
			action: z.enum(["speak", "ask", "prepare"]),
			utterance: z.string().nullable(),
			toolName: z.string().nullable(),
			toolInput: z.string().nullable(),
			drive: z.string(),
			evidenceRefs: strings,
		}),
	),
	agent: z.object({
		version: z.literal(1),
		seq: count,
		forgotten: strings,
		observationInputs: z.array(
			z.tuple([
				z.string(),
				z.object({ sources: strings, complete: z.boolean() }),
			]),
		),
		observations: z.array(
			z.object({
				id: z.string(),
				seq: count,
				text: z.string(),
				kind: z.string(),
				actor: z.enum(["user", "agent", "tool", "host"]),
				occurredAt: z.number(),
				refs: strings.optional(),
			}),
		),
		state: z.object({
			nextId: count,
			seenSeq: count,
			thoughts: z.array(
				derived.extend({ text: z.string(), drive: z.string() }),
			),
			facts: z.array(
				derived.extend({
					text: z.string(),
					aspect: z.string(),
					basis: z.enum(["stated", "observed", "hypothesis"]),
					evidence: strings,
					reason: z.string().nullable(),
					updatedAt: z.number(),
				}),
			),
			gaps: z.array(
				derived.extend({
					question: z.string(),
					why: z.string().nullable(),
					status: z.enum(["open", "answered", "declined"]),
					askedAt: z.number().nullable(),
					evidence: strings,
				}),
			),
			stock: z.array(
				derived.extend({
					text: z.string(),
					kind: z.enum(["finding", "idea", "question"]),
					targets: strings,
					sourceRefs: strings,
					freshUntil: z.number(),
					usedAt: z.number().nullable(),
				}),
			),
			preparing: z.array(
				timed.extend({
					ticketId: z.string(),
					toolName: z.string(),
					toolInput: z.string(),
					refs: strings,
				}),
			),
			pacing: z.object({
				lastAgentAt: z.number().nullable(),
				lastOwnAt: z.number().nullable(),
				unanswered: count,
				muteUntil: z.number().nullable(),
				prepareMuteUntil: z.number().nullable(),
				stopped: z.boolean(),
				lastOwnWasAsk: z.boolean(),
			}),
		}),
	}),
});
export function isAlwaysOnSnapshot(
	value: unknown,
): value is AlwaysOnHostSnapshot {
	return snapshotSchema.safeParse(value).success;
}

export function alwaysOnSources(value: AlwaysOnHostSnapshot): string[] {
	const s = value.agent;
	return [
		...new Set([
			...s.observations.flatMap((o) => [o.id, ...(o.refs ?? [])]),
			...(s.observationInputs ?? []).flatMap(([, i]) => i.sources),
			...s.state.thoughts.flatMap((x) => x.inputs),
			...s.state.facts.flatMap((x) => x.inputs),
			...s.state.gaps.flatMap((x) => x.inputs),
			...s.state.stock.flatMap((x) => x.inputs),
			...s.state.preparing.flatMap((x) => x.inputs),
			...value.tickets.flatMap((t) => t.inputs),
		]),
	];
}

export function alwaysOnTicketInput(
	snapshot: AlwaysOnHostSnapshot,
	id: string,
): InputContext | null {
	const ticket = snapshot.tickets.find((t) => t.id === id);
	return ticket ? { sources: ticket.inputs, complete: true } : null;
}
