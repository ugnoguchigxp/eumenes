import { defaultLimits } from "eumenes-agency";
import { currentInput } from "./input";
import { agencyResearchRequest } from "./research";
import type { AgencyHostDeps } from "./host-types";
import type { AlwaysOnScope } from "./always-on-scope";

/** Reconcile persisted proposals with confirmed local effects; never replay an unconfirmed utterance. */
export async function recoverAlwaysOnScope(
	deps: AgencyHostDeps,
	c: AlwaysOnScope,
	now: number,
) {
	if (!deps.state) return;
	for (const ticket of c.tickets) {
		const input = { sources: ticket.inputs, complete: true };
		if (ticket.action === "prepare") {
			if (!c.agent.view().preparing.some((p) => p.ticketId === ticket.id))
				continue;
			try {
				const args = agencyResearchRequest
					.omit({ revisionId: true })
					.parse(JSON.parse(ticket.toolInput ?? "null"));
				await deps.store.write((db) => {
					if (!currentInput(deps, db, input))
						throw new Error("agency_input_stale");
					deps.state!.startInTransaction(db, {
						rootId: `agency:${c.scope}:${ticket.id}`,
						conversationId: c.id,
						epoch: c.epoch,
						ticketId: ticket.id,
						revisionId: ticket.toolName!,
						...args,
						deadline: ticket.at + 30 * 60_000,
						sourceRefs: ticket.inputs,
						outboundIntervalMs: defaultLimits.outboundIntervalMs,
					});
				});
			} catch {
				// The existing execution ledger remains authoritative; no second task is made.
				c.agent.forget([`prepare:${ticket.id}`]);
				c.tickets = c.tickets.filter((t) => t.id !== ticket.id);
			}
		} else {
			const messageId = `agency:${c.scope}:${ticket.id}`;
			const source = deps.store.read((db) =>
				currentInput(deps, db, input)
					? deps.conversation.sourceInTransaction(db, messageId)
					: null,
			);
			if (source?.state === "available") {
				c.agent.recordResult(
					{
						ticketId: ticket.id,
						observationId: messageId,
						text: source.message.text,
						status: "succeeded",
						at: Date.parse(source.message.createdAt),
					},
					ticket,
				);
			}
			// Keep the core receipt; never replay a confirmed or unknown proposal.
			c.tickets = c.tickets.filter((t) => t.id !== ticket.id);
		}
		c.revision++;
	}
	c.touched = now;
}
