import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import {
	EVENTS_PER_UNIT,
	FORGET_RESOURCE,
	JOB_DEADLINE_MS,
	REQUESTS_PER_UNIT,
	FORGET_KEY,
	STEWARD_KIND,
	STEWARD_RESOURCE,
	STEWARD_SCOPE,
	type StepId,
	type UnitKind,
	type UnitSlot,
} from "../contracts";
import {
	type UnitTargets,
	conversationsWithWork,
	eventFailures,
	insertUnit,
	openUnitOf,
	pendingInbox,
	resolveInbox,
	setUnitJob,
} from "../repository";
import { kickWorld } from "./kick-world";
import { createClosureKick } from "./closure-kick";
import { steps } from "./steps";
import { pendingEvents } from "./steps/shared";
import type { StepEnv, StewardDeps } from "./types";
import type { Wake } from "./wake";

const log = getLogger("steward");

/** The writers of the profile's long-term layers (the memory reflection, the goals) are serialized. */
const LONG_TERM_KEY = "steward:long-term";

type UnitSpec = {
	step: StepId;
	kind: UnitKind;
	conversationId: string;
	targets: UnitTargets;
	/** Failed earlier attempts over the same target. */
	attempt: number;
};

const slotOf = (step: StepId): UnitSlot =>
	step === "forget-closure" ? "maintenance" : steps[step].slot;

/**
 * Making units: the unit row and its queue job are written together, so a unit never exists without its job.
 * A job is always available at once: a wait (a failed target, a deferred step) is the wake timer's, because a
 * job enqueued for later would hold its `concurrencyKey` for every unit behind it.
 * `kickInTransaction` looks at what a conversation still needs and makes the next unit; it never throws.
 *
 * The memory reflection runs for the conversation's new events (the handled events of the continuity flow) and for
 * the user's explicit requests (an inbox row). The closure delete of a forget is the steward's own, made by
 * `createClosureKick`.
 */
export function createKick(deps: StewardDeps, wake: Wake) {
	function createUnit(db: Database, spec: UnitSpec) {
		const slot = slotOf(spec.step);
		// A failed try of this kind waits; the timer kicks again when it is over.
		if (wake.paused(spec.conversationId, slot)) return false;
		const id = deps.newId();
		const availableAtMs = deps.nowMs();
		const llmStep = spec.step === "forget-closure" ? null : steps[spec.step];
		const concurrencyKey = llmStep
			? `steward:${spec.conversationId}`
			: FORGET_KEY;
		const longTerm = llmStep?.longTerm ?? false;
		db.exec("SAVEPOINT steward_unit");
		try {
			insertUnit(db, {
				id,
				conversationId: spec.conversationId,
				kind: spec.kind,
				step: spec.step,
				slot,
				targets: spec.targets,
				attempt: spec.attempt,
				createdAt: deps.clock(),
			});
			const { job } = deps.queue.enqueueInTransaction(db, {
				scope: STEWARD_SCOPE,
				kind: STEWARD_KIND,
				// A unit is one try; a new try is a new unit with a new id (the queue keeps finished jobs by this key).
				dedupeKey: id,
				payload: { unitId: id },
				subjectRef: spec.conversationId,
				lane: "background",
				// The closure delete asks no model: it takes no inference slot.
				resourceKey: llmStep ? STEWARD_RESOURCE : FORGET_RESOURCE,
				concurrencyKey: longTerm ? LONG_TERM_KEY : concurrencyKey,
				maxAttempts: 3,
				availableAtMs,
				deadlineAtMs: availableAtMs + JOB_DEADLINE_MS,
			});
			setUnitJob(db, id, job.id);
			db.exec("RELEASE steward_unit");
			return true;
		} catch (error) {
			db.exec("ROLLBACK TO steward_unit");
			db.exec("RELEASE steward_unit");
			log.warn(
				"steward.unit_not_created",
				{ stepId: spec.step, reason: "enqueue_failed" },
				error,
			);
			return false;
		}
	}

	const closure = createClosureKick(deps, (db, spec) =>
		createUnit(db, {
			step: "forget-closure",
			kind: "forget",
			conversationId: FORGET_KEY,
			targets: spec.targets,
			attempt: spec.attempt,
		}),
	);

	/**
	 * The next unit of the memory reflection: the conversation's new handled events and the explicit requests (the
	 * steps read the request's own message). Without either, the goal requests.
	 */
	function kickReflect(env: StepEnv) {
		const { db, conversationId } = env;
		if (openUnitOf(db, conversationId, "reflect")) return;
		const requests = pendingInbox(db, conversationId, REQUESTS_PER_UNIT);
		const events = pendingEvents(env).slice(0, EVENTS_PER_UNIT);
		if (events.length > 0 || requests.length > 0) {
			const failures = eventFailures(
				db,
				conversationId,
				events.map((event) => event.seq),
			);
			return createUnit(db, {
				step: "curate-memory",
				kind: "requests",
				conversationId,
				targets: {
					seqs: events.map((event) => event.seq),
					requests: requests.map((row) => row.id),
				},
				attempt: Math.max(
					0,
					...failures.values(),
					...requests.map((row) => row.failures),
				),
			});
		}
		kickGoals(env);
	}

	/**
	 * The goal requests. Without goals a goal request can not be served: it ends at once.
	 */
	function kickGoals(env: StepEnv) {
		const { db, deps: d, conversationId } = env;
		const requests = pendingInbox(
			db,
			conversationId,
			REQUESTS_PER_UNIT,
			"goal",
		);
		if (requests.length === 0) return;
		if (!d.goals) {
			for (const row of requests)
				resolveInbox(db, row.id, "none", "goals_unavailable", d.clock());
			return;
		}
		createUnit(db, {
			step: "curate-goals",
			kind: "requests",
			conversationId,
			targets: { requests: requests.map((row) => row.id) },
			attempt: Math.max(...requests.map((row) => row.failures)),
		});
	}

	/** What one conversation needs: its new events and explicit requests, and its World events. */
	function kickConversation(db: Database, conversationId: string) {
		try {
			const env: StepEnv = { db, deps, conversationId };
			if (deps.memory.readyInTransaction(db)) {
				kickReflect(env);
				// World is edited only while the user leaves the conversation, never between turns.
				kickWorld(env, wake, (spec) =>
					createUnit(db, {
						step: "curate-world",
						kind: "world_events",
						conversationId,
						targets: { events: spec.events },
						attempt: spec.attempt,
					}),
				);
			}
		} catch (error) {
			log.warn("steward.kick_failed", { reason: "kick_failed" }, error);
		}
	}

	/** A conversation's turn to be looked at, then the closure delete of the forgets waiting for it (a unit of its own). */
	function kickOne(db: Database, conversationId: string) {
		if (conversationId !== FORGET_KEY) kickConversation(db, conversationId);
		closure.kick(db);
	}

	/**
	 * Makes the units the steward needs: for the conversation named, or (at startup and when the timer is due) for
	 * every conversation with work: requests waiting, a unit open, handled events not yet read, or events World
	 * received that no step has touched yet. Called inside the transaction of a settle or a run's end; whatever
	 * fails inside leaves that transaction alone.
	 */
	function kickInTransaction(db: Database, conversationId?: string) {
		if (conversationId !== undefined) return kickOne(db, conversationId);
		const world = deps.world;
		const ids = new Set([
			...conversationsWithWork(db),
			...deps.continuity.events.conversationsWithUncuratedInTransaction(db),
			// Events World received that no step has touched yet (the notice that woke the steward is not durable).
			...(world
				? world.curation
						.pendingEventsInTransaction(db, world.scope, 200)
						.map((event) => event.conversationId)
				: []),
		]);
		for (const id of ids) kickConversation(db, id);
		// What the library holds excluded that no request names (a restored database) is closed too.
		closure.kick(db, { orphans: true });
	}
	wake.onWake(() => deps.store.write((db) => kickInTransaction(db)));
	return { kickInTransaction, kickOne };
}
export type Kick = ReturnType<typeof createKick>;
