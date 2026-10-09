import { expect, test } from "bun:test";
import type {
	ListChangesRequest,
	SourceAdapter,
	SourceChange,
	SourceChangeKind,
} from "..";
import {
	SCOPE,
	addMessage,
	claim,
	currentRef,
	entityOp,
	keyOf,
	registerClaim,
} from "./fixture";
import {
	crashHook,
	Crash,
	intakeStates,
	memoryForgetSource,
	openLife,
	reopenLife,
	rows,
	worldExternals,
	type Life,
} from "./lifecycle-fixture";

async function seed(life: Life) {
	expect((await life.lifecycle.recoverWorld()).status).toBe("open");
	await addMessage(life, "m1", "音声サービスは9月から利用できる。");
	await addMessage(life, "m2", "別の話題の発言。");
	expect((await life.world.apply(entityOp())).status).toBe("applied");
	for (const [key, id, message] of [
		["c-1", "claim-1", "m1"],
		["c-2", "claim-2", "m1"],
		["c-3", "claim-3", "m2"],
	] as const) {
		const result = await life.world.apply(
			registerClaim(key, claim(id, [currentRef(life, message)])),
		);
		expect(result.status).toBe("applied");
	}
}

const assertionIds = (life: Life): string[] =>
	(
		life.store.read((db) =>
			db.query("SELECT DISTINCT id FROM world_assertion ORDER BY id").all(),
		) as { id: string }[]
	).map((row) => row.id);
const lifecycleOf = (life: Life, id: string): string =>
	(
		life.store.read((db) =>
			db
				.query(
					"SELECT lifecycle FROM world_assertion WHERE id = ? ORDER BY revision DESC LIMIT 1",
				)
				.get(id),
		) as { lifecycle: string }
	).lifecycle;
const sourceCursor = (life: Life) =>
	life.store.read((db) => life.world.feedCursor(db, "source", SCOPE));

const change = (kind: SourceChangeKind, id: string): SourceChange => ({
	cursor: `c-${kind}-${id}`,
	kind,
	source: {
		namespace: "conversation",
		kind: "message",
		id,
		representation: "text",
	},
	revision: "r1",
	digest: kind === "retracted" ? "" : "d1",
	principal: SCOPE.principal,
	scopeKey: SCOPE.scopeKey,
	speaker: "user",
	occurredAt: "2026-10-09T00:00:00.000Z",
});
const fakeAdapter = (changes: SourceChange[]): SourceAdapter => {
	let served = false;
	return {
		namespace: "conversation",
		resolveCurrent: () => {
			throw new Error("unused");
		},
		readAuthorizedContent: () => {
			throw new Error("unused");
		},
		listChanges: (_db, _access, request: ListChangesRequest) => {
			const page = served ? [] : changes;
			served = true;
			return {
				changes: page,
				nextCursor: page.length === 0 ? (request.cursor ?? "p0") : "p1",
				hasMore: false,
			};
		},
	};
};

test("source feed: deletions and retractions are applied before additions and corrections", async () => {
	const life = await openLife({
		sources: [
			fakeAdapter([
				// Arrival order is the opposite of application order.
				change("corrected", "m2"),
				change("added", "m3"),
				change("corrected", "m1"),
				change("retracted", "m1"),
			]),
		],
	});
	try {
		await seed(life);
		const report = await life.lifecycle.consumeSourceChanges(SCOPE);
		// m1 is retracted: forgotten, and its (superseded) correction is not applied; m2's is.
		expect(report).toMatchObject({
			blocked: null,
			changes: 4,
			invalidated: 1,
			forgets: [{ complete: true }],
		});
		expect(assertionIds(life)).toEqual(["claim-3"]);
		expect(lifecycleOf(life, "claim-3")).toBe("invalidated");
		expect(intakeStates(life).map((i) => i.origin)).toEqual(["source_feed"]);
		expect(sourceCursor(life).cursor).toBe("p1");
		// The outbox cursor is its own: the Memory feed cursor is untouched.
		expect(
			life.store.read((db) => life.world.feedCursor(db, "memory", SCOPE))
				.cursor,
		).toBeNull();
		// Read again: nothing left to apply.
		expect(await life.lifecycle.consumeSourceChanges(SCOPE)).toMatchObject({
			changes: 0,
			forgets: [],
			invalidated: 0,
		});
	} finally {
		await life.cleanup();
	}
});

test("source feed: the cursor and the World effect roll back together", async () => {
	let life = await openLife();
	try {
		await seed(life);
		await life.conversation.correct({
			messageId: "m2",
			text: "訂正した発言。",
		});
		life = await reopenLife(life, { hook: crashHook("feed_cursor_saved") });
		await life.lifecycle.recoverWorld();
		await expect(
			life.lifecycle.consumeSourceChanges(SCOPE),
		).rejects.toBeInstanceOf(Crash);
		expect(sourceCursor(life).cursor).toBeNull();
		expect(lifecycleOf(life, "claim-3")).not.toBe("invalidated");
	} finally {
		await life.cleanup();
	}
});

test("real conversation outbox: a retraction forgets what stood on it; a later Memory forget closes the loop", async () => {
	const life = await openLife();
	try {
		await seed(life);
		await life.conversation.correct({
			messageId: "m2",
			text: "訂正した発言。",
		});
		await life.conversation.retract({ messageId: "m1" });
		const report = await life.lifecycle.consumeSourceChanges(SCOPE);
		expect(report.blocked).toBeNull();
		expect(report.forgets.map((f) => f.complete)).toEqual([true]);
		// m1 gone, m2's claim stopped (its correction is a new version, not a deletion).
		expect(assertionIds(life)).toEqual(["claim-3"]);
		expect(lifecycleOf(life, "claim-3")).toBe("invalidated");
		// The Memory edges of the deleted claims are still there; Memory's own forget of m1
		// lists them pending, and the feed confirms them against the already-erased World.
		const memory = await memoryForgetSource(life, keyOf("m1"));
		expect(worldExternals(life, memory.forgetId)).toHaveLength(2);
		const second = await life.lifecycle.consumeMemoryChanges(SCOPE);
		expect(second.forgets).toMatchObject([{ complete: true }]);
		expect(
			worldExternals(life, memory.forgetId).every(
				(e) => e.state === "confirmed",
			),
		).toBe(true);
	} finally {
		await life.cleanup();
	}
});

test("Memory notifications map to World roots: source/state/record forgotten become forget roots, other status changes only stop", async () => {
	const stateId = `state:${"a".repeat(64)}`;
	const recordId = `rec:${"b".repeat(64)}`;
	const note = (
		seq: number,
		targetType: "state_item" | "record" | "source",
		targetId: string,
		status: "forgotten" | "superseded" | "active",
		forgetId: string | null,
	) => ({
		seq,
		atMs: 1,
		scopeKey: SCOPE.scopeKey,
		targetType,
		targetId,
		revision: null,
		status,
		forgetId,
	});
	const life = await openLife({
		memory: {
			listChanges: () => ({
				status: "ok" as const,
				changes: [
					note(1, "state_item", stateId, "forgotten", "F1"),
					note(2, "record", recordId, "forgotten", "F1"),
					note(3, "source", keyOf("m2"), "forgotten", "F2"),
					note(4, "state_item", `state:${"c".repeat(64)}`, "superseded", null),
					note(5, "record", `rec:${"d".repeat(64)}`, "active", null),
				],
				nextAfterSeq: 5,
				hasMore: false,
			}),
		},
	});
	try {
		await seed(life);
		const report = await life.lifecycle.consumeMemoryChanges(SCOPE);
		// Memory has no such forgets: World deleted its side, but nothing is "complete".
		expect(report.forgets.map((f) => [f.forgetId, f.state, f.blocked])).toEqual(
			[
				["F1", "world_applied", "MEMORY_RECEIPT_MISSING"],
				["F2", "world_applied", "MEMORY_RECEIPT_MISSING"],
			],
		);
		expect(report.invalidated).toBe(1);
		const stored = life.store.read((db) =>
			db
				.query(
					"SELECT forget_id, roots_json FROM world_host_forget_intake ORDER BY forget_id",
				)
				.all(),
		) as { forget_id: string; roots_json: string }[];
		const mapped = stored.map((r) => [r.forget_id, JSON.parse(r.roots_json)]);
		expect(mapped).toEqual([
			[
				"F1",
				[
					{
						kind: "state",
						id: JSON.stringify(["memory", "state_item", stateId, null]),
						revision: 1,
					},
					{
						kind: "source",
						id: JSON.stringify(["memory", "record", recordId, "text"]),
						revision: 1,
					},
				],
			],
			["F2", [{ kind: "source", id: keyOf("m2"), revision: 1 }]],
		]);
		expect(assertionIds(life)).toEqual(["claim-1", "claim-2"]);
		expect(rows(life, "world_host_forget_confirmation")).toBe(0);
	} finally {
		await life.cleanup();
	}
});
