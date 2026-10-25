import type { Database } from "bun:sqlite";
import type { EventStore } from "../../domains/continuity";
import type { ConversationResourcePort } from "../../domains/dialogue";
import {
	parseResourceUri,
	type ResourceRegistry,
} from "../../domains/resources";
import type { ScreenCommand } from "../../domains/screen";
import { jstSeconds } from "../../infrastructure/jst-time";

export type ScreenEventDeps = {
	events: Pick<EventStore, "appendInTransaction">;
	ledger: Pick<ConversationResourcePort, "enterInTransaction">;
	registry: Pick<ResourceRegistry, "resolveInTransaction">;
};

/**
 * A screen command that settled, as the conversation's log tells it (spec resource-uri-implementation-plan
 * §8.2): an `acted` event of the host, `screen.done`, `screen.blocked`, `screen.unavailable` or
 * `screen.expired`, naming the resource by its number (`a<n>`) and the operation (`open` or `play`). It runs
 * in the settling transaction (the screen's `onSettled`), and a command yields exactly one event: a repeat
 * returns the first. The resource is found in the conversation's ledger by its URI; one that no longer
 * resolves is left unnamed. Returns null for a command that has not settled.
 */
export function screenSettledEventInTransaction(
	deps: ScreenEventDeps,
	db: Database,
	command: ScreenCommand,
) {
	if (command.status === "pending") return null;
	const at = jstSeconds(
		Date.parse(command.settledAt ?? new Date().toISOString()),
	);
	return deps.events.appendInTransaction(db, {
		conversationId: command.conversationId,
		at,
		type: "acted",
		by: "host",
		fields: {
			action: `screen.${command.status}`,
			...resourceRef(deps, db, command),
			operation: command.action,
		},
		dedupeKey: `screen:${command.seq}`,
	}).event;
}

/** `{ resource: "a<n>" }` of the command's resource; the ledger keeps the number it already has. */
function resourceRef(
	deps: ScreenEventDeps,
	db: Database,
	command: ScreenCommand,
): { resource: string } | undefined {
	const parsed = parseResourceUri(command.uri);
	if (!parsed) return undefined;
	const resolved = deps.registry.resolveInTransaction(db, parsed.uri);
	if (!resolved.ok) return undefined;
	const entered = deps.ledger.enterInTransaction(db, {
		conversationId: command.conversationId,
		uri: parsed.uri,
		kind: resolved.resource.kind,
		label: resolved.resource.label,
		source: "viewed",
	});
	return { resource: `a${entered.ref}` };
}
