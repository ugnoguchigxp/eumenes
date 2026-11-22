import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import {
	FORGET_RESOURCE,
	JOB_DEADLINE_MS,
	REQUESTS_PER_UNIT,
	SLEEP_JOB_DEADLINE_MS,
	FORGET_KEY,
	SLEEP_KEY,
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
	insertUnit,
	openUnitOf,
	pendingInbox,
	resolveInbox,
	setUnitJob,
} from "../repository";
import { kickWorld } from "./kick-world";
import { createSleepKick } from "./sleep/kick";
import { sleepSteps } from "./sleep/steps";
import { steps } from "./steps";
import type { StepEnv, StewardDeps } from "./types";
import type { Wake } from "./wake";

const log = getLogger("steward");

/** The writers of the profile's long-term layers (the explicit requests, the goals, the sleep layer) are serialized. */
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
	step in sleepSteps
		? sleepSteps[step as keyof typeof sleepSteps].slot
		: steps[step as keyof typeof steps].slot;

/**
 * Making units: the unit row and its queue job are written together, so a unit never exists without its job.
 * A job is always available at once: a wait (a failed target, a deferred step) is the wake timer's, because a
 * job enqueued for later would hold its `concurrencyKey` for every unit behind it.
 * `kickInTransaction` looks at what a conversation still needs and makes the next unit; it never throws.
 *
 * The steps that read the conversation run only for the user's explicit requests (an inbox row is the reason for a
 * unit, never an exchange). The sleep layer's units are the steward's own, made by `createSleepKick`.
 */
export function createKick(deps: StewardDeps, wake: Wake) {
	function createUnit(db: Database, spec: UnitSpec) {
		const slot = slotOf(spec.step);
		const sleepStep = sleepSteps[spec.step as keyof typeof sleepSteps];
		// A failed try of this kind waits; the timer kicks again when it is over.
		if (wake.paused(spec.conversationId, slot)) return false;
		const id = deps.newId();
		const availableAtMs = deps.nowMs();
		const concurrencyKey = sleepStep
			? sleepStep.concurrencyKey
			: `steward:${spec.conversationId}`;
		const longTerm = sleepStep
			? false
			: steps[spec.step as keyof typeof steps].longTerm;
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
				resourceKey:
					spec.step === "forget-closure" ? FORGET_RESOURCE : STEWARD_RESOURCE,
				concurrencyKey: longTerm ? LONG_TERM_KEY : concurrencyKey,
				maxAttempts: 3,
				availableAtMs,
				deadlineAtMs:
					availableAtMs +
					(sleepStep && spec.step !== "forget-closure"
						? SLEEP_JOB_DEADLINE_MS
						: JOB_DEADLINE_MS),
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

	const sleep = createSleepKick(deps, wake, (db, spec) =>
		createUnit(db, {
			step: spec.step,
			kind: spec.step === "forget-closure" ? "forget" : "sleep",
			conversationId: spec.step === "forget-closure" ? FORGET_KEY : SLEEP_KEY,
			targets: spec.targets,
			attempt: spec.attempt,
		}),
	);

	/** The next unit that answers the explicit requests of the conversation (the steps read the request's own message). */
	function kickReflect(env: StepEnv) {
		const { db, conversationId } = env;
		if (openUnitOf(db, conversationId, "reflect")) return;
		const requests = pendingInbox(db, conversationId, REQUESTS_PER_UNIT);
		if (requests.length > 0)
			return createUnit(db, {
				step: "curate-memory",
				kind: "requests",
				conversationId,
				targets: { requests: requests.map((row) => row.id) },
				attempt: Math.max(...requests.map((row) => row.failures)),
			});
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

	function kickOne(db: Database, conversationId: string) {
		// A sleep unit ended: the layer looks at the whole profile again ("the next one at once").
		if (conversationId === SLEEP_KEY || conversationId === FORGET_KEY)
			return sleep.kick(db);
		try {
			const env: StepEnv = { db, deps, conversationId };
			if (deps.memory.readyInTransaction(db)) {
				sleep.touch(db, conversationId);
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
		sleep.kick(db);
	}

	/**
	 * Makes the units the steward needs: for the conversation named, or (at startup and when the timer is due) for
	 * every conversation with work, the ones the steward knows and the ones with events World received that no
	 * step has touched yet. The sleep layer looks at the whole profile each time. Called inside the transaction of
	 * a settle or a run's end; whatever fails inside leaves that transaction alone.
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
		for (const id of ids) kickOne(db, id);
		// A look at the whole profile, and at what the library holds excluded that no request names (a restored database).
		sleep.kick(db, { orphans: true });
	}
	wake.onWake(() => deps.store.write((db) => kickInTransaction(db)));
	return { kickInTransaction, kickOne };
}
export type Kick = ReturnType<typeof createKick>;
