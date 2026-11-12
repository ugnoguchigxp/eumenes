import { SAID_KEPT } from "eumenes-agency/agenda";
import { workRoot } from "./always-on-flow";
import { wordsOf } from "./always-on-feed";
import type { AgendaScope } from "./always-on-scope";
import type { AgencyHostDeps } from "./host-types";

/**
 * Reconcile the saved research tickets with the work ledger after a restart: a ticket whose work is gone (the start
 * never committed, or it was revoked) is dropped, one whose work still runs or whose result is not yet taken stays.
 * Pending speech was never saved, so nothing is said twice; the agent asks again for what it still owes.
 */
export function recoverAgendaScope(
	deps: AgencyHostDeps,
	c: AgendaScope,
	now: number,
) {
	if (!deps.state) return;
	const alive = deps.store.read((db) =>
		c.tickets.filter((t) =>
			deps.state!.workActiveInTransaction(db, workRoot(c, t.id)),
		),
	);
	if (alive.length !== c.tickets.length) {
		c.tickets = alive;
		c.revision++;
	}
	c.touched = now;
}

/**
 * A new scope reads the conversation it joins: its latest messages, with the times they were said. The agent keeps its
 * words in working memory only, and a restart of the server is not a new conversation for the user; without this the
 * agent planned from an empty talk and knew neither what it had asked nor when it last spoke. The agent's own lines
 * come back as its words (`reply`).
 */
export function recallConversation(
	deps: AgencyHostDeps,
	c: AgendaScope,
	now: number,
) {
	const quiet = { ...c.agent.view().quiet };
	const recent = deps.conversation.get(c.id).messages;
	// As many words as the agent keeps (what is not words of the talk does not count).
	const read = deps.store
		.read((db) =>
			recent.flatMap((m) => {
				const words = wordsOf(deps, db, m.id);
				return words ? [words] : [];
			}),
		)
		.slice(-SAID_KEPT);
	for (const { message: m, text } of read) {
		const at = Date.parse(m.createdAt);
		if (!Number.isFinite(at)) continue;
		c.agent.observe({
			id: m.id,
			who: m.role === "user" ? "user" : "reply",
			text,
			at,
		});
		// Old words are no new evidence for the plans-and-interests note.
		c.profileSeen.add(m.id);
	}
	// The user's old words do not end a quiet they asked for after them.
	if (
		quiet.speechUntil !== null &&
		quiet.speechUntil > now &&
		c.agent.view().quiet.speechUntil === null
	)
		c.agent.setQuiet({
			scope: "speech",
			minutes: (quiet.speechUntil - now) / 60_000,
			at: now,
		});
}
