import type { Database } from "bun:sqlite";
import { expect } from "bun:test";
import {
	createConversationSourceAdapter,
	createWorldCuration,
	type CurationModelView,
	type CurationOptions,
	type CurationPrepareResult,
	type CurationSettleResult,
	type IntakePorts,
	type PendingCurationEvent,
	type PreparedCuration,
	type WorldCuration,
} from "..";
import {
	ACCESS,
	NOW,
	PURPOSE,
	SCOPE,
	TEST_CURSOR_SECRET,
	entityOp,
} from "./fixture";
import { openLife, type Life } from "./lifecycle-fixture";

/** What the host says about messages: shared by the feed (intake) and by curation. */
export function testPorts() {
	const adopted = new Set<string>();
	const blocked = new Set<string>();
	const received: string[][] = [];
	const intake: IntakePorts = {
		isAdoptedAnswer: (_db: Database, id: string) => adopted.has(id),
		blockedMessageIds: (_db: Database, ids: Iterable<string>) =>
			new Set([...ids].filter((id) => blocked.has(id))),
		onEventsReceived: (conversationIds: string[]) => {
			received.push(conversationIds);
		},
	};
	return { adopted, blocked, received, intake };
}
export type TestPorts = ReturnType<typeof testPorts>;

export type Rig = {
	life: Life;
	curation: WorldCuration;
	ports: TestPorts;
	/** Everything a model was shown, one entry per prepare that was ready. */
	shown: CurationModelView[];
};

/** Curation wired to a Life with the real World package and the real conversation adapter. */
export function curationFor(
	life: Life,
	ports: TestPorts = testPorts(),
	over: Partial<CurationOptions> = {},
): Rig {
	const curation = createWorldCuration({
		world: life.world,
		lifecycle: life.lifecycle,
		sources: [
			createConversationSourceAdapter(life.conversation, {
				allowedPurposes: [PURPOSE],
				cursorSecret: TEST_CURSOR_SECRET,
			}),
		],
		intake: ports.intake,
		gate: life.gate,
		purpose: PURPOSE,
		clock: () => 1791500000000,
		...over,
	});
	return { life, curation, ports, shown: [] };
}

export type Answer = (
	model: CurationModelView,
	prepared: PreparedCuration,
) => unknown;

export type Run = {
	prepare: CurationPrepareResult;
	settle?: CurationSettleResult;
};

export const pending = (
	rig: Rig,
	limit = 12,
	conversationId?: string,
): PendingCurationEvent[] =>
	rig.life.store.readSnapshot((db) =>
		rig.curation.pendingEventsInTransaction(db, SCOPE, limit, conversationId),
	);

/** One window: prepare, the "model" answers, settle. Each stage is its own writer transaction. */
export async function curate(
	rig: Rig,
	answer: Answer,
	eventIds: readonly string[] = pending(rig).map((e) => e.eventId),
): Promise<Run> {
	const prepare = await rig.life.store.write((db) =>
		rig.curation.prepareCurationInTransaction(db, { scope: SCOPE, eventIds }),
	);
	if (prepare.status !== "ready") return { prepare };
	rig.shown.push(prepare.prepared.model);
	const output = answer(prepare.prepared.model, prepare.prepared);
	const settle = await rig.life.store.write((db) =>
		rig.curation.settleCurationInTransaction(db, {
			prepared: prepare.prepared,
			output,
		}),
	);
	return { prepare, settle };
}

/** Curates windows until nothing is pending or one does not settle; the runs, in order. */
export async function drain(
	rig: Rig,
	answer: Answer,
	max = 10,
): Promise<Run[]> {
	const runs: Run[] = [];
	for (let i = 0; i < max; i++) {
		if (pending(rig).length === 0) break;
		const run = await curate(rig, answer);
		runs.push(run);
		if (run.settle?.status !== "settled") break;
	}
	return runs;
}

export const nothing: Answer = () => ({ entities: [], claims: [] });

/** One claim of an answer about the shown entity `ref`, standing on utterance `label`. */
export const claimOf = (
	over: Record<string, unknown> = {},
): Record<string, unknown> => ({
	op: "assert",
	ref: null,
	subject: "w1",
	predicate: "available",
	value: { type: "boolean", value: true },
	relation: null,
	evidence: "e1",
	origin: "user_report",
	validFrom: null,
	validUntil: null,
	...over,
});

export const inboxRows = (life: Life) =>
	life.store.read((db) =>
		db
			.query(
				"SELECT event_id, feed_key, seq, status FROM world_inbox ORDER BY seq, event_id",
			)
			.all(),
	) as { event_id: string; feed_key: string; seq: number; status: string }[];

export const checkpointRows = (life: Life) =>
	life.store.read((db) =>
		db
			.query(
				"SELECT feed_key, received_cursor, applied_cursor FROM world_checkpoint ORDER BY feed_key",
			)
			.all(),
	) as {
		feed_key: string;
		received_cursor: string | null;
		applied_cursor: string | null;
	}[];

export const mirrorRows = (life: Life) =>
	life.store.read((db) =>
		db
			.query(
				"SELECT event_id, seq, state, reason, speaker, conversation_id, held_context_digest, manifest_id, received_cursor, settled_at_ms FROM world_host_extract_event ORDER BY seq",
			)
			.all(),
	) as {
		event_id: string;
		seq: number;
		state: string;
		reason: string | null;
		speaker: string;
		conversation_id: string | null;
		held_context_digest: string | null;
		settled_at_ms: number | null;
		manifest_id: string | null;
		received_cursor: string;
	}[];

export const assertionRows = (life: Life) =>
	life.store.read((db) =>
		db
			.query(
				"SELECT id, revision, lifecycle, origin FROM world_assertion ORDER BY id, revision",
			)
			.all(),
	) as { id: string; revision: number; lifecycle: string; origin: string }[];

// --- shared by the curation test files -------------------------------------

export const TEXT = "音声サービスは9月から利用できる。";

export async function started(ports = testPorts()) {
	const life = await openLife({ intake: ports.intake });
	expect((await life.lifecycle.recoverWorld()).status).toBe("open");
	const rig = curationFor(life, ports);
	return { life, rig, ports };
}

export async function received(life: Life) {
	return life.lifecycle.consumeSourceChanges(SCOPE);
}

/** The heads World holds now: claim id -> lifecycle, origin and payload. */
export async function heads(life: Life) {
	const read = await life.world.read({
		access: ACCESS,
		scope: SCOPE,
		asOf: NOW,
	});
	if (read.status !== "ready") throw new Error(JSON.stringify(read));
	return new Map(
		read.snapshot.assertions.map((a) => [
			a.id,
			{ lifecycle: a.lifecycle, origin: a.origin, revision: a.revision, a },
		]),
	);
}

export const one = <T>(items: readonly T[]): T => {
	expect(items).toHaveLength(1);
	return items[0]!;
};

export function ready(
	run: Awaited<ReturnType<typeof curate>>,
): PreparedCuration {
	if (run.prepare.status !== "ready")
		throw new Error(`prepare: ${run.prepare.status} ${run.prepare.reason}`);
	return run.prepare.prepared;
}
export function settled(run: Awaited<ReturnType<typeof curate>>) {
	if (run.settle?.status !== "settled")
		throw new Error(`settle: ${JSON.stringify(run.settle)}`);
	return run.settle;
}

export const withService = async (life: Life) => {
	expect((await life.world.apply(entityOp())).status).toBe("applied");
};
