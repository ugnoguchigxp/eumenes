import { notesMentioned } from "eumenes-agency/agenda";
import type { Database } from "bun:sqlite";
import type { OutboxEvent } from "../../domains/conversation";
import type { Message } from "../../domains/conversation/contracts";
import { imageReferenceText } from "../../domains/conversation";
import type { AgendaHearing } from "./always-on-heard";
import { noteRef, type AgendaScope } from "./always-on-scope";
import { recoverAgendaScope } from "./always-on-recovery";
import type { AgencyHostDeps } from "./host-types";

/** Words of the host's own (its speech, the notes it showed) are not exchanges to learn from. */
const own = (id: string) =>
	id.startsWith("agency:") || id.startsWith("agency-note:");

/**
 * A message as the agent reads it: its words with the images they refer to. Null when it is not words of the talk (an
 * artifact, a note the host showed, something the memory blocked or the user took back).
 */
export function wordsOf(
	deps: AgencyHostDeps,
	db: Database,
	messageId: string,
): { message: Message; text: string } | null {
	const source = deps.conversation.sourceInTransaction(db, messageId);
	if (
		source.state !== "available" ||
		source.message.presentation === "artifact" ||
		deps.memory.isBlockedInTransaction?.(db, messageId)
	)
		return null;
	const m = source.message;
	if (
		m.id.startsWith("agency-note:") ||
		(m.role !== "user" && m.role !== "assistant")
	)
		return null;
	const images = deps.conversation
		.imageReferencesInTransaction(db, m.id)
		.filter((ref) => !deps.memory.isBlockedInTransaction?.(db, ref.messageId));
	const text = [m.text, imageReferenceText(images)].filter(Boolean).join("\n");
	return text.trim() ? { message: m, text } : null;
}

/**
 * One change of the conversation reaches the agent: the user's words (they call off the step out and go to the reply
 * being written), the reply (once the user has heard it), a correction (the old line and what rests on it are
 * forgotten) or a retraction.
 */
export function feedAgenda(input: {
	deps: AgencyHostDeps;
	c: AgendaScope;
	event: OutboxEvent;
	at: number;
	hearing: AgendaHearing;
	forget(c: AgendaScope, refs: readonly string[]): void;
	/** Shows notes the adopted reply `runId` showed (after the read). */
	show(c: AgendaScope, noteIds: readonly string[], runId: string): void;
	/** A reply is in the conversation: the exchange is complete (the profile writer reads it, behind the talk). */
	exchanged(c: AgendaScope): void;
}) {
	const { deps, c, event, at, hearing } = input;
	if (event.kind === "retracted") {
		hearing.drop(c, event.sourceId);
		input.forget(c, [event.sourceId]);
		c.generation++;
		c.controller?.abort();
		return;
	}
	const words = deps.store.read((db) => wordsOf(deps, db, event.sourceId));
	if (!words || own(words.message.id)) return;
	const { message: m, text } = words;
	let id = m.id;
	if (event.kind === "corrected") {
		// The corrected words replace the old ones and what was derived from them.
		hearing.drop(c, m.id);
		input.forget(c, [m.id]);
		id = `${m.id}:c${event.seq}`;
	}
	const when = Date.parse(m.createdAt) || at;
	if (m.role === "user") {
		// What the agent was saying is said: the user answers it.
		hearing.flush(c, when);
		c.generation++;
		// The plan and the line out now are for words before these: called off.
		c.controller?.abort();
		c.agent.observe({ id, who: "user", text, at: when });
		// A reply being written takes these words into its next model call (a message its prompt holds
		// already, or a correction, is not sent).
		if (event.kind !== "corrected" && c.reply && !c.reply.included.has(m.id))
			c.steering?.send(m.id);
		c.revision++;
		c.touched = at;
		return;
	}
	const calls = m.runId ? c.calls.get(m.runId) : undefined;
	const shows = m.runId ? c.shows.get(m.runId) : undefined;
	if (m.runId) {
		c.calls.delete(m.runId);
		c.shows.delete(m.runId);
		c.given.delete(m.runId);
	}
	c.revision++;
	c.touched = at;
	// The reply is said when the user has heard it: the agent's gaps run from there, and the plan sees it then.
	hearing.appeared(c, { id: m.id, at: when, own: false }, (saidAt) => {
		// Forgotten while it was read: the agent is not told of it.
		if (!deps.store.read((db) => wordsOf(deps, db, m.id))) return;
		c.agent.observe({
			id,
			who: "reply",
			text,
			at: saidAt,
			...(calls ? { calls } : {}),
		});
		for (const note of notesMentioned(text, c.notes.map(noteRef)))
			c.agent.noteUsed(note, saidAt);
		// The exchange is processed: the plan sees it at once.
		c.agent.infoChanged(Math.max(at, saidAt));
		c.revision++;
		input.exchanged(c);
	});
	if (m.runId && shows?.length) input.show(c, shows, m.runId);
}

type FeedHost = {
	deps: AgencyHostDeps;
	convs: Map<string, AgendaScope>;
	persisted: Map<string, number>;
	recovering: Set<string>;
	on(): boolean;
	now(): number;
	refresh(c: AgendaScope): Promise<void>;
	invalidate(c: AgendaScope): void;
	/** Reads the outbox up to its head into the agents (synchronously). */
	feedEvents(): void;
	collect(): Promise<void>;
	save(): Promise<void>;
	syncBusy(): void;
	dispose(c: AgendaScope): void;
};

export async function pumpAgendaHost(input: FeedHost) {
	const { deps, convs, recovering, persisted, on, now } = input;
	if (!on()) return;
	for (const id of recovering) {
		const c = convs.get(id);
		if (c) recoverAgendaScope(deps, c, now());
		recovering.delete(id);
	}
	for (const c of convs.values()) {
		if (
			deps.store.read((db) => deps.state!.epochInTransaction(db, c.id)) !==
			c.epoch
		) {
			input.invalidate(c);
			input.dispose(c);
			convs.delete(c.id);
			persisted.delete(c.id);
		} else await input.refresh(c);
	}
	input.feedEvents();
	await input.collect();
	await input.save();
	input.syncBusy();
}
