import type { PendingCurationEvent } from "../../world";
import { openUnitOf, worldEventCounts } from "../repository";
import { restOf } from "./rest";
import type { StepEnv } from "./types";
import type { Wake } from "./wake";

/** Events World may list at once, and the events one unit curates. */
const PENDING_READ = 200;
/**
 * A unit curates the events of ONE run: the user's message and the adopted answer, two at most. World's package
 * makes every message of the window part of the manifest of each claim made from it, so the closure a claim stands
 * on stays small (two messages) instead of growing with the number of events in the window.
 */
const EVENTS_PER_UNIT = 2;

type Located = { key: string; runId: string | null };

/** The run an event's message belongs to: the events of one run are curated together. */
function locate(env: StepEnv, event: PendingCurationEvent): Located {
	const message = env.deps.conversation.messageInTransaction(
		env.db,
		event.messageId,
	)?.message;
	if (!message?.runId) return { key: event.messageId, runId: null };
	return { key: message.runId, runId: message.runId };
}

/** An event may be curated unless its run is still going (it may yet record more). A blocked source is closed by World's prepare. */
const ready = (env: StepEnv, at: Located) =>
	at.runId === null || env.deps.runStateOf(at.runId) !== "active";

/**
 * The next World unit of a conversation, made only while the conversation rests (World is edited when the user has
 * left, never between turns; the rest is the interval the user chose between the agent's own utterances): the
 * events of the oldest run that may be curated. Events are taken in the order World received them; a run that
 * must wait holds the later ones back.
 */
export function kickWorld(
	env: StepEnv,
	wake: Wake,
	make: (spec: { events: string[]; attempt: number }) => boolean,
) {
	const { db, deps, conversationId } = env;
	const world = deps.world;
	if (!world || openUnitOf(db, conversationId, "world")) return;
	const pending = world.curation.pendingEventsInTransaction(
		db,
		world.scope,
		PENDING_READ,
		conversationId,
	);
	const groups = new Map<
		string,
		Array<{ event: PendingCurationEvent; at: Located }>
	>();
	for (const event of pending) {
		const at = locate(env, event);
		const group = groups.get(at.key) ?? [];
		group.push({ event, at });
		groups.set(at.key, group);
	}
	// A run has two events at most; more (the corrected versions of a message) are curated in later windows.
	const windows = [...groups.values()].flatMap((group) =>
		Array.from({ length: Math.ceil(group.length / EVENTS_PER_UNIT) }, (_, i) =>
			group.slice(i * EVENTS_PER_UNIT, (i + 1) * EVENTS_PER_UNIT),
		),
	);
	if (windows.length === 0) return;
	// Only a resting conversation is curated; the timer is the user's own interval running out.
	const rest = restOf(db, deps, [conversationId]);
	if (!rest.rested) {
		if (rest.restAt !== null) wake.at(rest.restAt);
		return;
	}
	const window = windows[0]!;
	if (window.some(({ at }) => !ready(env, at))) return;
	const ids = window.map((e) => e.event.eventId);
	const counts = worldEventCounts(db, ids);
	make({
		events: ids,
		attempt: Math.max(0, ...ids.map((id) => counts.get(id)?.failures ?? 0)),
	});
}
