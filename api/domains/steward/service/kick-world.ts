import { getLogger } from "../../../infrastructure/logger";
import type { PendingCurationEvent } from "../../world";
import {
	deleteRoutesOfMessages,
	deleteWorldEvents,
	insertDecision,
	insertDecisionRefs,
	openUnitOf,
	readRoute,
	worldEventCounts,
} from "../repository";
import type { StepEnv } from "./types";
import type { Wake } from "./wake";

const log = getLogger("steward");

/** Events World may list at once, and the events one unit curates. */
const PENDING_READ = 200;
/**
 * A unit curates the events of ONE run: the user's message and the adopted answer, two at most. World's package
 * makes every message of the window part of the manifest of each claim made from it, so the closure a claim stands
 * on stays small (two messages) instead of growing with the number of events in the window.
 */
const EVENTS_PER_UNIT = 2;

type Verdict = "wait" | "live" | "empty";
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

/** The messages whose handled events the memory reflection has not read yet (it judges what World needs of them). */
function unjudgedMessages(env: StepEnv): Set<string> {
	const { db, deps, conversationId } = env;
	const events = deps.continuity.events;
	return new Set(
		[
			...events.uncuratedInTransaction(db, conversationId),
			...events.pendingInTransaction(db, conversationId),
		].flatMap((event) => event.messageIds),
	);
}

/**
 * Section 3.4 of the World plan: may the event be curated now, and does it need the model?
 *  - wait: the memory reflection has not judged its message yet (or the run is still going and may record it);
 *  - empty: curate-memory judged this very version of the message to hold nothing about the world;
 *  - live: everything else, including a message that is never judged (skipped, blocked), a
 *    message of another version than the one judged (a correction) and a missing judgment.
 */
function verdictOf(
	env: StepEnv,
	event: PendingCurationEvent,
	at: Located,
	unjudged: ReadonlySet<string>,
): Verdict {
	const { db, deps } = env;
	// A blocked source is closed by World's prepare (`SOURCE_BLOCKED`): it needs no judgment.
	if (
		deps.memory.blockedMessageIdsInTransaction(db, [event.messageId]).size > 0
	)
		return "live";
	if (unjudged.has(event.messageId)) return "wait";
	const route = readRoute(db, event.messageId, event.revision, event.digest);
	if (route === null)
		return at.runId !== null && deps.runStateOf(at.runId) === "active"
			? "wait"
			: "live";
	return route.world === false ? "empty" : "live";
}

/**
 * Settles the events judged to hold nothing about the world, without a model: World moves its applied position on and
 * the decision record says so. All in a savepoint: a failure leaves the events pending.
 */
function settleRouted(
	env: StepEnv,
	events: readonly PendingCurationEvent[],
	wake: Wake,
): boolean {
	const { db, deps, conversationId } = env;
	const world = deps.world!;
	db.exec("SAVEPOINT steward_route_empty");
	try {
		const settled = world.curation.settleEmptyInTransaction(
			db,
			world.scope,
			events.map((e) => e.eventId),
		);
		const messageIds = events.map((e) => e.messageId);
		const id = insertDecision(db, {
			conversationId,
			jobId: `routed-${deps.newId()}`,
			step: "curate-world",
			createdAt: deps.clock(),
			output: { routed: "empty" },
			results: [{ status: "routed_empty", events: settled.length }],
			windowVersionBefore: null,
			windowVersionAfter: null,
			durationMs: null,
			outputTokens: null,
			errorCode: null,
		});
		insertDecisionRefs(
			db,
			id,
			messageIds.map((message) => ({ type: "message" as const, id: message })),
		);
		deleteWorldEvents(db, settled);
		deleteRoutesOfMessages(db, messageIds);
		db.exec("RELEASE steward_route_empty");
		return true;
	} catch (error) {
		db.exec("ROLLBACK TO steward_route_empty");
		db.exec("RELEASE steward_route_empty");
		log.warn(
			"steward.world_route_failed",
			{ reason: "settle_empty_failed" },
			error,
		);
		wake.captureFailed(conversationId, "world");
		return false;
	}
}

/**
 * The next World unit of a conversation: the events of the oldest run that may be curated. Events are taken in
 * the order World received them; a run that must wait holds the later ones back.
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
	const unjudged = unjudgedMessages(env);
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
	for (const window of windows) {
		const verdicts = window.map(({ event, at }) =>
			verdictOf(env, event, at, unjudged),
		);
		if (verdicts.includes("wait")) return;
		const empty = window.filter((_, i) => verdicts[i] === "empty");
		if (
			empty.length > 0 &&
			!settleRouted(
				env,
				empty.map((e) => e.event),
				wake,
			)
		)
			return;
		const live = window.filter((_, i) => verdicts[i] === "live");
		if (live.length === 0) continue;
		const ids = live.map((e) => e.event.eventId);
		const counts = worldEventCounts(db, ids);
		make({
			events: ids,
			attempt: Math.max(0, ...ids.map((id) => counts.get(id)?.failures ?? 0)),
		});
		return;
	}
}
