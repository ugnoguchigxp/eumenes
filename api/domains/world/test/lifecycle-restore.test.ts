import { expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { CONTRACT_VERSIONS } from "eumenes-memory";
import { reconcileForgetJournal } from "eumenes-memory/sqlite";
import { createWorldService, readWorldJournal, type LifecyclePoint } from "..";
import {
	ACCESS,
	NOW,
	SCOPE,
	addMessage,
	claim,
	currentRef,
	entityOp,
	keyOf,
	memoryPolicyRevision,
	registerClaim,
} from "./fixture";
import {
	Crash,
	backupDatabase,
	crashHook,
	intakeStates,
	memoryForgetSource,
	openLife,
	reopenLife,
	restoreDatabase,
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

const readRequest = { access: ACCESS, scope: SCOPE, asOf: NOW };
const readStatus = (life: Life) => life.world.read(readRequest);
const assertionIds = (life: Life): string[] =>
	(
		life.store.read((db) =>
			db.query("SELECT DISTINCT id FROM world_assertion ORDER BY id").all(),
		) as { id: string }[]
	).map((row) => row.id);
const restoreEpoch = (life: Life) =>
	life.store.read((db) => life.world.restoreEpoch(db));
const cursor = (life: Life) =>
	life.store.read((db) => life.world.feedCursor(db, "memory", SCOPE));
const tombstoned = (life: Life, id: string): number =>
	(
		life.store.read((db) =>
			db
				.query(
					"SELECT COUNT(*) AS n FROM world_tombstone WHERE kind = 'source' AND id = ?",
				)
				.get(id),
		) as { n: number }
	).n;

/** Memory forgets m1; World learns it from the feed. */
async function forgetThroughFeed(life: Life) {
	const memory = await memoryForgetSource(life, keyOf("m1"));
	const consumed = await life.lifecycle.consumeMemoryChanges(SCOPE);
	return { memory, consumed };
}

const reconcileMemory = (
	life: Life,
	entry: Awaited<ReturnType<typeof memoryForgetSource>>["entry"],
) =>
	life.store.write((db) =>
		reconcileForgetJournal(db, {
			contractVersion: CONTRACT_VERSIONS.lifecycle,
			entries: [entry],
			clock: { atMs: NOW },
		}),
	);

test("Memory change feed: a forgotten source becomes a durable forget and completes; the cursor moves with it", async () => {
	const life = await openLife();
	try {
		await seed(life);
		expect(cursor(life)).toMatchObject({ cursor: null, stale: false });
		const { memory, consumed } = await forgetThroughFeed(life);
		expect(consumed).toMatchObject({
			resync: false,
			blocked: null,
			forgets: [{ complete: true }],
		});
		expect(assertionIds(life)).toEqual(["claim-3"]);
		expect(intakeStates(life)).toEqual([
			{ forget_id: memory.forgetId, state: "complete", origin: "memory_feed" },
		]);
		expect(cursor(life).cursor).not.toBeNull();
		expect(
			worldExternals(life, memory.forgetId).every(
				(e) => e.state === "confirmed",
			),
		).toBe(true);
		const again = await life.lifecycle.consumeMemoryChanges(SCOPE);
		expect(again).toMatchObject({ changes: 0, forgets: [], hasMore: false });
		expect(readWorldJournal(life.journalPath)).toHaveLength(1);
	} finally {
		await life.cleanup();
	}
});

test("a stale feed cursor (restore epoch bumped) is ignored and the whole feed is read again", async () => {
	const life = await openLife();
	try {
		await seed(life);
		const { memory } = await forgetThroughFeed(life);
		const saved = cursor(life).cursor;
		expect(saved).not.toBeNull();
		await life.store.write((db) => life.world.bumpRestoreEpochInWriter(db));
		expect(cursor(life)).toMatchObject({ cursor: null, stale: true });
		const resynced = await life.lifecycle.consumeMemoryChanges(SCOPE);
		expect(resynced.resync).toBe(true);
		expect(resynced.changes).toBeGreaterThan(0);
		// The same Memory forget is recognised: no second journal entry.
		expect(resynced.forgets.map((f) => f.complete)).toEqual([true]);
		expect(readWorldJournal(life.journalPath)).toHaveLength(1);
		expect(cursor(life)).toMatchObject({ cursor: saved, stale: false });
		expect(intakeStates(life).map((i) => i.forget_id)).toEqual([
			memory.forgetId,
		]);
	} finally {
		await life.cleanup();
	}
});

test("the feed cursor and the intake are written in the same callback: a rolled-back callback moves nothing", async () => {
	let life = await openLife();
	try {
		await seed(life);
		life = await reopenLife(life, { hook: crashHook("feed_cursor_saved") });
		await life.lifecycle.recoverWorld();
		await memoryForgetSource(life, keyOf("m1"));
		await expect(
			life.lifecycle.consumeMemoryChanges(SCOPE),
		).rejects.toBeInstanceOf(Crash);
		expect(cursor(life).cursor).toBeNull();
		expect(rows(life, "world_host_forget_intake")).toBe(0);
		expect(assertionIds(life)).toEqual(["claim-1", "claim-2", "claim-3"]);
	} finally {
		await life.cleanup();
	}
});

type Observation = { point: string; hostOpen: boolean; world: string };

/** An old database restored under a newer journal, with the World journal kept. */
async function restoredScenario(
	over: { memoryReconciled: boolean; crash?: LifecyclePoint } = {
		memoryReconciled: true,
	},
) {
	let life = await openLife();
	await seed(life);
	const backup = backupDatabase(life);
	const epochBefore = restoreEpoch(life);
	const { memory } = await forgetThroughFeed(life);
	expect(assertionIds(life)).toEqual(["claim-3"]);
	expect(readWorldJournal(life.journalPath)).toHaveLength(1);
	const observed: Observation[] = [];
	let current: Life | undefined;
	const watch: LifecyclePoint[] = [
		"restore_begun",
		"before_restore_finish",
		"restore_finished",
	];
	const crash = over.crash === undefined ? undefined : crashHook(over.crash);
	life = await restoreDatabase(life, backup, {
		hook: (point, info) => {
			if (watch.includes(point) && current !== undefined) {
				const raw = createWorldService({
					store: current.store,
					policyRevision: memoryPolicyRevision,
					sources: [],
				});
				observed.push({
					point,
					hostOpen: current.gate.isOpen(),
					world: current.store.readSnapshot(
						(db) => raw.readSnapshot(db, readRequest).status,
					),
				});
			}
			crash?.(point, info);
		},
	});
	current = life;
	// The old database still holds everything, including what was forgotten later.
	expect(assertionIds(life)).toEqual(["claim-1", "claim-2", "claim-3"]);
	if (over.memoryReconciled) {
		// Memory restored too: its own journal is re-applied (Memory's job).
		expect(await reconcileMemory(life, memory.entry)).toMatchObject({
			status: "ok",
			reapplied: 1,
			feedResyncRequired: true,
		});
	}
	return { life, memory, epochBefore, observed };
}

test("A32: old DB + newer journal reaches restore.finish, keeps forgotten items forgotten, and keeps the gate closed until then", async () => {
	const { life, memory, epochBefore, observed } = await restoredScenario();
	try {
		expect(life.gate.isOpen()).toBe(false);
		const report = await life.lifecycle.recoverWorld({
			memoryFeedResyncRequired: true,
		});
		expect(report).toMatchObject({ status: "open", restored: true });
		// The host gate and World's own Scope gate were both closed through the steps.
		expect(observed.map((o) => [o.point, o.hostOpen, o.world])).toEqual([
			["restore_begun", false, "blocked"],
			["before_restore_finish", false, "blocked"],
			["restore_finished", false, "ready"],
		]);
		expect(life.gate.isOpen()).toBe(true);
		// Forgotten items stay forgotten; the rest of the old database is intact.
		expect(assertionIds(life)).toEqual(["claim-3"]);
		expect(tombstoned(life, keyOf("m1"))).toBe(1);
		// New restore epoch, feed cursors dropped.
		expect(restoreEpoch(life)).not.toBe(epochBefore);
		expect(cursor(life)).toMatchObject({ cursor: null, stale: false });
		expect((await readStatus(life)).status).toBe("ready");
		// The forget the old DB never saw is adopted and re-confirmed against Memory's receipt.
		expect(intakeStates(life)).toEqual([
			{ forget_id: memory.forgetId, state: "complete", origin: "restored" },
		]);
		expect(
			worldExternals(life, memory.forgetId).every(
				(e) => e.state === "confirmed",
			),
		).toBe(true);
		// TOMBSTONED: a forgotten source cannot be depended on again.
		expect(
			await life.world.apply(
				registerClaim("again", claim("claim-9", [currentRef(life, "m1")])),
			),
		).toMatchObject({ status: "rejected" });
		expect(assertionIds(life)).toEqual(["claim-3"]);
		// Reading the whole Memory feed again recognises the forget (nothing is re-deleted twice).
		const resynced = await life.lifecycle.consumeMemoryChanges(SCOPE);
		expect(resynced).toMatchObject({ resync: false, blocked: null });
		expect(assertionIds(life)).toEqual(["claim-3"]);
	} finally {
		await life.cleanup();
	}
});

test("A32: the journal alone detects a restored DB; an unreconciled Memory keeps the confirmation pending, honestly", async () => {
	const { life, memory } = await restoredScenario({ memoryReconciled: false });
	try {
		const report = await life.lifecycle.recoverWorld();
		expect(report).toMatchObject({
			status: "open",
			restored: true,
			pendingForgets: [memory.forgetId],
		});
		// World content of the forget is gone even though Memory has not caught up.
		expect(assertionIds(life)).toEqual(["claim-3"]);
		expect(life.lifecycle.forgetStatus(memory.forgetId)).toMatchObject({
			state: "world_applied",
			complete: false,
			blocked: "MEMORY_RECEIPT_MISSING",
		});
		// Memory catches up (its own recover) and the same forget finishes.
		await reconcileMemory(life, memory.entry);
		expect(await life.lifecycle.resumeForget(memory.forgetId)).toMatchObject({
			state: "complete",
			complete: true,
		});
		expect(
			worldExternals(life, memory.forgetId).every(
				(e) => e.state === "confirmed",
			),
		).toBe(true);
	} finally {
		await life.cleanup();
	}
});

for (const point of [
	"restore_begun",
	"restore_registered",
	"restore_reconciled",
	"before_restore_finish",
] as const) {
	test(`a crash during restore (${point}) resumes the same restore, not a new epoch`, async () => {
		const { life: crashed, memory } = await restoredScenario({
			memoryReconciled: true,
			crash: point,
		});
		let life = crashed;
		try {
			await expect(
				life.lifecycle.recoverWorld({ memoryFeedResyncRequired: true }),
			).rejects.toBeInstanceOf(Crash);
			expect(life.gate.isOpen()).toBe(false);
			const epochAtCrash = restoreEpoch(life);
			life = await reopenLife(life);
			// No flag this time: the persisted in-progress restore is what resumes.
			expect(await life.lifecycle.recoverWorld()).toMatchObject({
				status: "open",
				restored: true,
			});
			expect(restoreEpoch(life)).toBe(epochAtCrash);
			expect(assertionIds(life)).toEqual(["claim-3"]);
			expect(intakeStates(life).map((i) => i.state)).toEqual(["complete"]);
			expect(
				worldExternals(life, memory.forgetId).every(
					(e) => e.state === "confirmed",
				),
			).toBe(true);
			expect((await readStatus(life)).status).toBe("ready");
			// Once finished it does not restore again.
			expect(await life.lifecycle.recoverWorld()).toMatchObject({
				status: "open",
				restored: false,
			});
		} finally {
			await life.cleanup();
		}
	});
}

test("journal corruption, truncation and rollback keep World closed (fail closed)", async () => {
	const cases: {
		name: string;
		reason: string;
		damage: (path: string) => void;
	}[] = [
		{
			name: "garbage line",
			reason: "JOURNAL_MALFORMED",
			damage: (path) => writeFileSync(path, "not json\n"),
		},
		{
			name: "torn last line",
			reason: "JOURNAL_MALFORMED",
			damage: (path) =>
				writeFileSync(path, readFileSync(path, "utf8").trimEnd()),
		},
		{
			name: "edited entry",
			reason: "JOURNAL_CHAIN_BROKEN",
			damage: (path) =>
				writeFileSync(
					path,
					readFileSync(path, "utf8").replace('\\"m1\\"', '\\"mX\\"'),
				),
		},
		{
			name: "journal deleted",
			reason: "JOURNAL_TRUNCATED",
			damage: (path) => rmSync(path, { force: true }),
		},
		{
			name: "journal rolled back to an empty older copy",
			reason: "JOURNAL_TRUNCATED",
			damage: (path) => writeFileSync(path, ""),
		},
	];
	for (const item of cases) {
		let life = await openLife();
		try {
			await seed(life);
			await forgetThroughFeed(life);
			item.damage(life.journalPath);
			life = await reopenLife(life);
			const report = await life.lifecycle.recoverWorld();
			expect([item.name, report]).toEqual([
				item.name,
				{ status: "closed", reason: item.reason },
			]);
			expect(life.gate.isOpen()).toBe(false);
			expect(life.gate.reason()).toBe(item.reason);
			// Nothing of World is served or written while closed.
			expect(await readStatus(life)).toEqual({
				status: "blocked",
				reasonCode: "WORLD_RECOVERY_REQUIRED",
			});
			expect(
				await life.world.apply(registerClaim("k", claim("claim-7", []))),
			).toMatchObject({
				status: "blocked",
				reasonCode: "WORLD_RECOVERY_REQUIRED",
			});
		} finally {
			await life.cleanup();
		}
	}
});
