import { notesMentioned } from "eumenes-agency/agenda";
import type { OutboxEvent } from "../../domains/conversation";
import { imageReferenceText } from "../../domains/conversation";
import { noteRef, type AgendaScope } from "./always-on-scope";
import { recoverAgendaScope } from "./always-on-recovery";
import type { AgencyHostDeps } from "./host-types";

/** Words of the host's own (its speech, the notes it showed) are not exchanges to learn from. */
const own = (id: string) =>
	id.startsWith("agency:") || id.startsWith("agency-note:");

/**
 * One change of the conversation reaches the agent: the user's words (they call off the step out and go to the reply
 * being written), the reply, a correction (the old line and what rests on it are forgotten) or a retraction.
 */
export function feedAgenda(input: {
	deps: AgencyHostDeps;
	c: AgendaScope;
	event: OutboxEvent;
	at: number;
	forget(c: AgendaScope, refs: readonly string[]): void;
	/** Shows notes the adopted reply `runId` showed (after the read). */
	show(c: AgendaScope, noteIds: readonly string[], runId: string): void;
}) {
	const { deps, c, event, at } = input;
	if (event.kind === "retracted") {
		input.forget(c, [event.sourceId]);
		c.generation++;
		c.controller?.abort();
		return;
	}
	const shown: Array<[string, string[]]> = [];
	deps.store.read((db) => {
		const source = deps.conversation.sourceInTransaction(db, event.sourceId);
		if (
			source.state !== "available" ||
			source.message.presentation === "artifact" ||
			deps.memory.isBlockedInTransaction?.(db, event.sourceId)
		)
			return;
		const m = source.message;
		if (own(m.id) || (m.role !== "user" && m.role !== "assistant")) return;
		const images = deps.conversation
			.imageReferencesInTransaction(db, m.id)
			.filter(
				(ref) => !deps.memory.isBlockedInTransaction?.(db, ref.messageId),
			);
		const text = [m.text, imageReferenceText(images)]
			.filter(Boolean)
			.join("\n");
		if (!text.trim()) return;
		let id = m.id;
		if (event.kind === "corrected") {
			// The corrected words replace the old ones and what was derived from them.
			input.forget(c, [m.id]);
			id = `${m.id}:c${event.seq}`;
		}
		const when = Date.parse(m.createdAt) || at;
		if (m.role === "user") {
			c.generation++;
			// The plan and the line out now are for words before these: called off.
			c.controller?.abort();
			c.agent.observe({ id, who: "user", text, at: when });
			// A reply being written takes these words into its next model call (a message its prompt holds
			// already, or a correction, is not sent).
			if (event.kind !== "corrected" && c.reply && !c.reply.included.has(m.id))
				c.steering?.send(m.id);
		} else {
			const calls = m.runId ? c.calls.get(m.runId) : undefined;
			if (m.runId) c.calls.delete(m.runId);
			const shows = m.runId ? c.shows.get(m.runId) : undefined;
			if (m.runId) {
				c.shows.delete(m.runId);
				c.given.delete(m.runId);
			}
			if (m.runId && shows?.length) shown.push([m.runId, shows]);
			c.agent.observe({
				id,
				who: "reply",
				text,
				at: when,
				...(calls ? { calls } : {}),
			});
			for (const note of notesMentioned(text, c.notes.map(noteRef)))
				c.agent.noteUsed(note, when);
			// The exchange is processed: the plan sees it at once.
			c.agent.infoChanged(at);
		}
		c.revision++;
		c.touched = at;
	});
	for (const [runId, noteIds] of shown) input.show(c, noteIds, runId);
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
