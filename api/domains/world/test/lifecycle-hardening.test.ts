/**
 * Review round 1 hardening of the World lifecycle on a REAL host store:
 * Memory confirmation coverage, root validation, abandoned parts, restore
 * re-verification, single-flight recovery, collision-safe part ids and the
 * multi-part forget with Memory externals. Fixture-grade (no model, explicit
 * claims on confirmed messages); the SQL, Memory and World are real.
 */
import { expect, test } from "bun:test";
import { MemoryStoreError } from "eumenes-memory/sqlite";
import {
	createWorldContextBroker,
	createWorldLifecycle,
	defaultMemoryPort,
	readWorldJournal,
	type ForgetReport,
	type WorldApplyRequest,
	type WorldService,
} from "..";
import { insertIntake } from "../repository/lifecycle";
import {
	ACCESS,
	NOW,
	PURPOSE,
	SCOPE,
	addMessage,
	adoptPlan,
	claim,
	currentRef,
	entityOp,
	keyOf,
	registerClaim,
	request,
} from "./fixture";
import {
	intakeStates,
	memoryForgetSource,
	openLife,
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
const readStatus = (life: Life) =>
	life.world.read({ access: ACCESS, scope: SCOPE, asOf: NOW });
const sqlOne = (life: Life, sql: string, ...params: string[]) =>
	life.store.read((db) => db.query(sql).get(...params));

const must = <T>(value: T | { status: "rejected" }): T => {
	if (typeof value === "object" && value !== null && "status" in value)
		throw new Error(`rejected: ${JSON.stringify(value)}`);
	return value as T;
};

/** A second lifecycle over the same store whose World calls can be observed or replaced. */
function lifecycleWith(
	life: Life,
	intercept: (
		db: Parameters<WorldService["applyInWriter"]>[0],
		req: WorldApplyRequest,
	) => ReturnType<WorldService["applyInWriter"]> | null,
	over: Partial<Parameters<typeof createWorldLifecycle>[0]> = {},
) {
	const world: WorldService = {
		...life.world,
		applyInWriter: (db, req) =>
			intercept(db, req) ?? life.world.applyInWriter(db, req),
	};
	return createWorldLifecycle({
		store: life.store,
		world,
		journalPath: life.journalPath,
		gate: life.gate,
		purpose: PURPOSE,
		scopes: [SCOPE],
		clock: () => NOW,
		...over,
	});
}

const bigRoots = (n: number, prefix = "bulk") =>
	Array.from({ length: n }, (_, i) => ({
		kind: "source" as const,
		id: JSON.stringify(["conversation", "message", `${prefix}-${i}`, "text"]),
	}));

// --- 1. a Memory forget's externals are confirmed only when World erased them --------

test("unrelated roots never confirm a Memory forget's externals; a covering intake of the same forget does", async () => {
	const life = await openLife();
	try {
		await seed(life);
		const memory = await memoryForgetSource(life, keyOf("m1"));
		expect(worldExternals(life, memory.forgetId)).toHaveLength(2);

		const unrelated = must(
			await life.lifecycle.acceptForget({
				forgetId: "unrelated-1",
				scope: SCOPE,
				reasonCode: "SOURCE_FORGOTTEN",
				roots: [{ kind: "source", id: keyOf("m2") }],
				memoryForgetId: memory.forgetId,
			}),
		) as ForgetReport;
		expect(unrelated).toMatchObject({
			state: "world_applied",
			complete: false,
			blocked: "MEMORY_EXTERNAL_NOT_COVERED",
		});
		// Memory still shows both pending; nothing was recorded for them.
		expect(
			worldExternals(life, memory.forgetId).every((e) => e.state === "pending"),
		).toBe(true);
		expect(rows(life, "world_host_forget_confirmation")).toBe(2);
		expect(
			sqlOne(
				life,
				"SELECT COUNT(*) AS n FROM world_host_forget_confirmation WHERE state = 'confirmed'",
			),
		).toEqual({ n: 0 });
		// m1's claims are untouched: the unrelated forget did not reach them.
		expect(assertionIds(life)).toEqual(["claim-1", "claim-2"]);

		// A second intake of the SAME Memory forget whose roots do cover them.
		const cover = must(
			await life.lifecycle.acceptForget({
				forgetId: "cover-1",
				scope: SCOPE,
				reasonCode: "SOURCE_FORGOTTEN",
				roots: [{ kind: "source", id: keyOf("m1") }],
				memoryForgetId: memory.forgetId,
			}),
		) as ForgetReport;
		expect(cover).toMatchObject({
			state: "complete",
			complete: true,
			externals: { total: 2, confirmed: 2 },
		});
		expect(
			worldExternals(life, memory.forgetId).every(
				(e) => e.state === "confirmed",
			),
		).toBe(true);
		expect(await life.lifecycle.resumeForget("unrelated-1")).toMatchObject({
			state: "complete",
			complete: true,
		});
	} finally {
		await life.cleanup();
	}
});

test("an external whose host row is gone has no World content left: it is confirmed even with unrelated roots", async () => {
	const life = await openLife();
	try {
		await seed(life);
		const memory = await memoryForgetSource(life, keyOf("m1"));
		const ids = worldExternals(life, memory.forgetId).map((e) => e.externalId);
		await life.store.write((db) => {
			for (const id of ids)
				db.query("DELETE FROM world_host_dependent WHERE external_id = ?").run(
					id as string,
				);
		});
		const report = must(
			await life.lifecycle.acceptForget({
				forgetId: "gone-1",
				scope: SCOPE,
				reasonCode: "SOURCE_FORGOTTEN",
				roots: [{ kind: "source", id: keyOf("m2") }],
				memoryForgetId: memory.forgetId,
			}),
		) as ForgetReport;
		expect(report).toMatchObject({ state: "complete", complete: true });
	} finally {
		await life.cleanup();
	}
});

// --- 2. root validation, abandoned parts, gate message ---------------------------------

test("roots are validated like World before intake and journal; the part separator is reserved", async () => {
	const life = await openLife();
	try {
		await seed(life);
		const base = {
			scope: SCOPE,
			reasonCode: "FORGET_REQUESTED" as const,
		};
		const refused = async (forgetId: string, roots: unknown[]) =>
			life.lifecycle.acceptForget({ ...base, forgetId, roots } as never);
		const invalid = {
			status: "rejected" as const,
			reasonCode: "INVALID_INPUT" as const,
		};
		// 256 bytes for non-source kinds, 8192 only for source/state.
		expect(
			await refused("v1", [{ kind: "entity", id: "e".repeat(257) }]),
		).toEqual(invalid);
		expect(
			await refused("v2", [{ kind: "assertion", id: "é".repeat(129) }]),
		).toEqual(invalid);
		expect(
			await refused("v3", [{ kind: "source", id: "s".repeat(8193) }]),
		).toEqual(invalid);
		expect(
			await refused("v4", [{ kind: "state", id: "é".repeat(4097) }]),
		).toEqual(invalid);
		// Lone surrogates, empty ids, unknown kinds, bad revisions.
		expect(await refused("v5", [{ kind: "source", id: "a\ud800b" }])).toEqual(
			invalid,
		);
		expect(await refused("v6", [{ kind: "source", id: "" }])).toEqual(invalid);
		expect(await refused("v7", [{ kind: "bogus", id: "x" }])).toEqual(invalid);
		expect(
			await refused("v8", [{ kind: "source", id: "x", revision: 0 }]),
		).toEqual(invalid);
		// One bad root rejects the whole request, even behind valid ones.
		expect(
			await refused("v9", [
				{ kind: "source", id: keyOf("m1") },
				{ kind: "entity", id: "e".repeat(300) },
			]),
		).toEqual(invalid);
		// Forget ids: well-formed, and without the reserved part separator.
		expect(await refused("a~1", [{ kind: "source", id: keyOf("m1") }])).toEqual(
			invalid,
		);
		expect(
			await refused("\udc00x", [{ kind: "source", id: keyOf("m1") }]),
		).toEqual(invalid);
		// Nothing was taken in: no intake row, no journal entry, World content intact.
		expect(rows(life, "world_host_forget_intake")).toBe(0);
		expect(readWorldJournal(life.journalPath)).toHaveLength(0);
		expect(assertionIds(life)).toEqual(["claim-1", "claim-2", "claim-3"]);
		// The longest legal source key is accepted.
		const longest = must(
			await life.lifecycle.acceptForget({
				...base,
				forgetId: "ok-long",
				roots: [{ kind: "source", id: "s".repeat(8192) }],
			}),
		) as ForgetReport;
		expect(longest).toMatchObject({ complete: true });
	} finally {
		await life.cleanup();
	}
});

/** An accepted-and-journaled intake holding roots only a damaged writer could produce. */
async function insertJournaled(
	life: Life,
	forgetId: string,
	roots: { kind: never; id: string; revision: number }[],
) {
	await life.store.write((db) =>
		insertIntake(
			db,
			{
				forgetId,
				principal: SCOPE.principal,
				scopeKey: SCOPE.scopeKey,
				memoryForgetId: null,
				memoryFinal: true,
				reasonCode: "FORGET_REQUESTED",
				origin: "request",
				roots,
				rootsDigest: "0".repeat(64),
				state: "journaled",
			},
			NOW,
		),
	);
}
const badEntity = (i: number) => ({
	kind: "entity" as never,
	id: `bad-${i}-${"x".repeat(300)}`,
	revision: 1,
});
const m1Root = { kind: "source" as never, id: keyOf("m1"), revision: 1 };

test("one invalid root does not block the valid roots of its part; the forget is reported, never complete", async () => {
	const life = await openLife();
	try {
		await seed(life);
		await insertJournaled(life, "partial-1", [m1Root, badEntity(1)]);
		const report = await life.lifecycle.resumeForget("partial-1");
		expect(report).toMatchObject({
			state: "complete",
			complete: false,
			blocked: "WORLD_ROOTS_ABANDONED",
			abandoned: { parts: 0, roots: 1 },
		});
		// The valid root was applied.
		expect(assertionIds(life)).toEqual(["claim-3"]);
		expect((await readStatus(life)).status).toBe("ready");
		// The gate is not held shut by it, and the report names it.
		expect(await life.lifecycle.recoverWorld()).toMatchObject({
			status: "open",
			abandonedForgets: ["partial-1"],
			pendingForgets: [],
		});
		expect(life.lifecycle.forgetStatus("partial-1")?.complete).toBe(false);
	} finally {
		await life.cleanup();
	}
});

test("a part with no valid root is abandoned (durable), the next part still runs and every part is reopened except it", async () => {
	const life = await openLife();
	try {
		await seed(life);
		const roots = Array.from({ length: 500 }, (_, i) => badEntity(i));
		roots.push(m1Root as never);
		await insertJournaled(life, "poison-part", roots as never);
		const report = await life.lifecycle.resumeForget("poison-part");
		expect(report).toMatchObject({
			state: "complete",
			complete: false,
			abandoned: { parts: 1, roots: 500 },
		});
		expect(assertionIds(life)).toEqual(["claim-3"]);
		expect(
			sqlOne(
				life,
				"SELECT part, whole_part, skipped_roots, reason FROM world_host_forget_abandoned WHERE forget_id = 'poison-part'",
			),
		).toEqual({
			part: 0,
			whole_part: 1,
			skipped_roots: 500,
			reason: "NO_VALID_ROOTS",
		});
		expect((await readStatus(life)).status).toBe("ready");
	} finally {
		await life.cleanup();
	}
});

test("a part World itself refuses as invalid input is abandoned explicitly instead of holding the gate forever", async () => {
	const life = await openLife();
	try {
		await seed(life);
		const poison = keyOf("poison-source");
		const lifecycle = lifecycleWith(life, (_db, req) =>
			req.operation.kind === "forget.chunk" &&
			req.operation.roots.some((r) => r.id === poison)
				? { status: "rejected", reasonCode: "INVALID_INPUT", stage: "world" }
				: null,
		);
		expect((await lifecycle.recoverWorld()).status).toBe("open");
		const report = must(
			await lifecycle.acceptForget({
				forgetId: "world-refused",
				scope: SCOPE,
				reasonCode: "FORGET_REQUESTED",
				roots: [{ kind: "source", id: poison }],
			}),
		) as ForgetReport;
		expect(report).toMatchObject({
			state: "complete",
			complete: false,
			blocked: "WORLD_ROOTS_ABANDONED",
			abandoned: { parts: 1, roots: 1 },
		});
		expect(
			sqlOne(
				life,
				"SELECT reason FROM world_host_forget_abandoned WHERE forget_id = 'world-refused'",
			),
		).toEqual({ reason: "WORLD_INVALID_INPUT" });
		expect(await lifecycle.recoverWorld()).toMatchObject({
			status: "open",
			abandonedForgets: ["world-refused"],
		});
	} finally {
		await life.cleanup();
	}
});

test("the gate message names the real reason and how many forgets wait", async () => {
	const life = await openLife();
	try {
		await seed(life);
		const lifecycle = lifecycleWith(life, (_db, req) =>
			req.operation.kind === "forget.chunk"
				? { status: "blocked", reasonCode: "WRITER_BUSY", stage: "host" }
				: null,
		);
		await lifecycle.recoverWorld();
		await lifecycle.acceptForget({
			forgetId: "stuck-1",
			scope: SCOPE,
			reasonCode: "FORGET_REQUESTED",
			roots: [{ kind: "source", id: keyOf("m1") }],
		});
		const report = await lifecycle.recoverWorld();
		expect(report).toEqual({
			status: "closed",
			reason: "FORGET_PENDING:WORLD_WRITER_BUSY:1",
		});
		expect(life.gate.reason()).toBe("FORGET_PENDING:WORLD_WRITER_BUSY:1");
	} finally {
		await life.cleanup();
	}
});

test("feeds: roots World would refuse are counted and skipped, and never stop the cursor", async () => {
	const note = (
		seq: number,
		targetId: string,
		forgetId: string | null,
		status: "forgotten" | "active" = "forgotten",
	) => ({
		seq,
		atMs: 1,
		scopeKey: SCOPE.scopeKey,
		targetType: "source" as const,
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
					note(1, keyOf("m1"), "FA"),
					note(2, "z".repeat(9000), "FA"),
					note(3, "y".repeat(9000), "FB"),
					note(4, keyOf("m2"), "F~tilde"),
				],
				nextAfterSeq: 4,
				hasMore: false,
			}),
		},
	});
	try {
		await seed(life);
		const report = await life.lifecycle.consumeMemoryChanges(SCOPE);
		expect(report).toMatchObject({ blocked: null, rejectedRoots: 2 });
		// FA (valid root kept) and the tilde id (hashed) became intakes; FB had nothing valid.
		const ids = intakeStates(life).map((i) => i.forget_id);
		expect(ids).toHaveLength(2);
		expect(ids).toContain("FA");
		expect(ids.find((id) => id !== "FA")).toMatch(/^mf-[0-9a-f]{24}$/);
		expect(assertionIds(life)).toEqual([]);
		expect(
			life.store.read((db) => life.world.feedCursor(db, "memory", SCOPE))
				.cursor,
		).toBe("4");
		expect(
			sqlOne(
				life,
				"SELECT memory_forget_id FROM world_host_forget_intake WHERE forget_id <> 'FA'",
			),
		).toEqual({ memory_forget_id: "F~tilde" });
	} finally {
		await life.cleanup();
	}
});

// --- 7(f) duplicate roots compare equal on both sides -----------------------------------

test("a Memory notification with duplicate targets re-read after a cursor reset is the same intake", async () => {
	const dup = (seq: number) => ({
		seq,
		atMs: 1,
		scopeKey: SCOPE.scopeKey,
		targetType: "source" as const,
		targetId: keyOf("m1"),
		revision: null,
		status: "forgotten" as const,
		forgetId: "F9",
	});
	const life = await openLife({
		memory: {
			listChanges: () => ({
				status: "ok" as const,
				changes: [dup(1), dup(2)],
				nextAfterSeq: 2,
				hasMore: false,
			}),
		},
	});
	try {
		await seed(life);
		await life.lifecycle.consumeMemoryChanges(SCOPE);
		await life.store.write((db) =>
			db.query("DELETE FROM world_host_feed_cursor").run(),
		);
		await life.lifecycle.consumeMemoryChanges(SCOPE);
		expect(intakeStates(life).map((i) => i.forget_id)).toEqual(["F9"]);
	} finally {
		await life.cleanup();
	}
});

// --- 4. restore re-verification ----------------------------------------------------------

async function completedForgetWithMemory(life: Life) {
	await seed(life);
	const memory = await memoryForgetSource(life, keyOf("m1"));
	const report = must(
		await life.lifecycle.acceptForget({
			forgetId: memory.forgetId,
			scope: SCOPE,
			reasonCode: "SOURCE_FORGOTTEN",
			roots: [{ kind: "source", id: keyOf("m1") }],
			memoryForgetId: memory.forgetId,
		}),
	) as ForgetReport;
	expect(report).toMatchObject({ state: "complete", complete: true });
	return memory;
}

test("after a restore, a completed forget whose Memory receipt shows unreachable pending externals does not stay complete", async () => {
	let mode: "ok" | "pending" = "ok";
	const life = await openLife({
		memory: {
			receipt: (db, access, forgetId) => {
				const found = defaultMemoryPort.receipt(db, access, forgetId);
				return mode === "pending" && found.status === "found"
					? {
							status: "found",
							externals: found.externals.map((e) => ({
								...e,
								state: "pending" as const,
							})),
						}
					: found;
			},
		},
	});
	try {
		const memory = await completedForgetWithMemory(life);
		const original = life.store.read(
			(db) =>
				db
					.query("SELECT external_id, depends_json FROM world_host_dependent")
					.all() as { external_id: string; depends_json: string }[],
		);
		// The restored host rows no longer reach the roots (m2 instead of m1).
		await life.store.write((db) => {
			db.query(
				"UPDATE world_host_dependent SET depends_json = replace(depends_json, ?, ?)",
			).run(
				JSON.stringify(keyOf("m1")).slice(1, -1),
				JSON.stringify(keyOf("m2")).slice(1, -1),
			);
		});
		mode = "pending";
		const report = await life.lifecycle.startRestore();
		expect(report.status).toBe("closed");
		expect(report).toMatchObject({
			reason: "MEMORY_UNVERIFIED:MEMORY_EXTERNAL_NOT_COVERED:1",
		});
		expect(life.gate.isOpen()).toBe(false);
		expect(life.lifecycle.forgetStatus(memory.forgetId)).toMatchObject({
			state: "world_applied",
			complete: false,
			blocked: "MEMORY_EXTERNAL_NOT_COVERED",
		});
		// The picture is repaired (and Memory is reachable again): the next recover finishes it.
		await life.store.write((db) => {
			for (const row of original)
				db.query(
					"UPDATE world_host_dependent SET depends_json = ? WHERE external_id = ?",
				).run(row.depends_json, row.external_id);
		});
		mode = "ok";
		expect(await life.lifecycle.recoverWorld()).toMatchObject({
			status: "open",
			pendingForgets: [],
		});
		expect(life.lifecycle.forgetStatus(memory.forgetId)).toMatchObject({
			state: "complete",
			complete: true,
		});
		expect(life.gate.isOpen()).toBe(true);
	} finally {
		await life.cleanup();
	}
});

test("after a restore, a transient Memory error while re-checking never leaves the forget complete or the gate open", async () => {
	let down = false;
	const life = await openLife({
		memory: {
			receipt: (db, access, forgetId) => {
				if (down) throw new MemoryStoreError("CORRUPT_ROW");
				return defaultMemoryPort.receipt(db, access, forgetId);
			},
		},
	});
	try {
		const memory = await completedForgetWithMemory(life);
		down = true;
		const report = await life.lifecycle.startRestore();
		expect(report).toEqual({
			status: "closed",
			reason: "MEMORY_UNVERIFIED:MEMORY_UNAVAILABLE:1",
		});
		expect(life.lifecycle.forgetStatus(memory.forgetId)).toMatchObject({
			state: "world_applied",
			complete: false,
		});
		down = false;
		expect(await life.lifecycle.recoverWorld()).toMatchObject({
			status: "open",
			restored: false,
		});
		expect(life.lifecycle.forgetStatus(memory.forgetId)).toMatchObject({
			state: "complete",
			complete: true,
		});
	} finally {
		await life.cleanup();
	}
});

// --- 7(b) a later, stricter Memory verdict for the same key wins ---------------------------

test("restore: a later page whose dependent Memory rejects overrides an earlier 'registered' for the same key", async () => {
	const life = await openLife();
	try {
		await seed(life);
		const dependents = life.store.read(
			(db) =>
				db
					.query(
						"SELECT external_id FROM world_host_dependent ORDER BY external_id",
					)
					.all() as { external_id: string }[],
		);
		expect(dependents.length).toBeGreaterThanOrEqual(2);
		const second = dependents[1]!.external_id;
		const told: { sourceKey: string; status: string }[][] = [];
		const lifecycle = lifecycleWith(
			life,
			(_db, req) => {
				if (req.operation.kind === "restore.register")
					told.push(
						req.operation.registrations.map((r) => ({
							sourceKey: r.sourceKey,
							status: r.status,
						})),
					);
				return null;
			},
			{
				dependentPageSize: 1,
				memory: {
					register: (db, access, atMs, scopeKey, deps) =>
						deps.some(
							(d) => d.externalId === second || d.externalId.startsWith("w1p-"),
						)
							? { status: "rejected", reasonCode: "TOMBSTONED" }
							: defaultMemoryPort.register(db, access, atMs, scopeKey, deps),
				},
			},
		);
		await lifecycle.startRestore();
		const flat = told.flat().filter((r) => r.sourceKey === keyOf("m1"));
		expect(flat.map((r) => r.status)).toEqual(["registered", "tombstoned"]);
	} finally {
		await life.cleanup();
	}
});

// --- 7(c) single-flight recovery -------------------------------------------------------------

test("concurrent recoverWorld calls are serialised: the gate stays shut while a restore runs", async () => {
	const seen: boolean[] = [];
	const life = await openLife({
		hook: (point) => {
			if (point === "restore_registered" || point === "restore_reconciled")
				seen.push(life.gate.isOpen());
		},
	});
	try {
		await seed(life);
		const [quick, restore] = await Promise.all([
			life.lifecycle.recoverWorld(),
			life.lifecycle.recoverWorld({ restored: true }),
		]);
		expect(quick.status).toBe("open");
		expect(restore).toMatchObject({ status: "open", restored: true });
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.every((open) => !open)).toBe(true);
		expect(life.gate.isOpen()).toBe(true);
	} finally {
		await life.cleanup();
	}
});

// --- 7(a) forget epoch: an answer prepared before a forget can never be adopted ---------------

test("accepting a forget moves the Scope's forget epoch: in-flight slice usage is rejected by it", async () => {
	const life = await openLife();
	try {
		await seed(life);
		// Adopt claim-3 (on m2) so the Slice has something to say.
		expect(
			(
				await life.world.apply(
					request("ad-3", {
						kind: "assertion.transition",
						plan: adoptPlan("claim-3", 1),
					}),
				)
			).status,
		).toBe("applied");
		const broker = createWorldContextBroker({
			store: life.store,
			world: life.world,
			clock: () => NOW,
			purpose: PURPOSE,
		});
		const prepared = await life.store.write((db) =>
			broker.prepareInTransaction(db, {
				runId: "r-epoch",
				conversationId: "c1",
				jobId: "j",
				attempt: 1,
				generation: 0,
				reservedBytes: 0,
				nowMs: NOW,
			}),
		);
		if (prepared.status !== "ready") throw new Error(JSON.stringify(prepared));
		const verdict = () =>
			life.store.readSnapshot((db) =>
				broker.validateInTransaction(
					db,
					{
						runId: "r-epoch",
						conversationId: "c1",
						jobId: "j",
						attempt: 1,
						generation: 0,
						inference: null,
						nowMs: NOW,
					},
					prepared.context,
				),
			);
		expect(verdict()).toEqual({ ok: true });
		const before = life.store.read((db) => life.world.forgetEpoch(db, SCOPE));
		// Accepted but not advanced: World content is untouched, only the epoch moves.
		await life.lifecycle.acceptForget(
			{
				forgetId: "epoch-1",
				scope: SCOPE,
				reasonCode: "FORGET_REQUESTED",
				roots: [{ kind: "source", id: keyOf("m1") }],
			},
			{ advance: false },
		);
		expect(life.store.read((db) => life.world.forgetEpoch(db, SCOPE))).not.toBe(
			before,
		);
		expect(verdict()).toEqual({
			ok: false,
			reason: "world_forget_epoch_changed",
		});
	} finally {
		await life.cleanup();
	}
});

// --- 8. more than 500 roots WITH a Memory forget: per-part chunks and per-part reopen ----------

test("A30+: >500 roots with a Memory forget confirm every external and reopen each part", async () => {
	const life = await openLife();
	try {
		await seed(life);
		const memory = await memoryForgetSource(life, keyOf("m1"));
		expect(worldExternals(life, memory.forgetId)).toHaveLength(2);
		const ops: { kind: string; forgetId: string }[] = [];
		const lifecycle = lifecycleWith(life, (_db, req) => {
			const op = req.operation;
			if (op.kind === "forget.chunk" || op.kind === "forget.reopen")
				ops.push({ kind: op.kind, forgetId: op.forgetId });
			return null;
		});
		expect((await lifecycle.recoverWorld()).status).toBe("open");
		// The Memory forget's real target is the LAST root: it lands in the second part.
		const roots = [
			...bigRoots(600),
			{ kind: "source" as const, id: keyOf("m1") },
		];
		const report = must(
			await lifecycle.acceptForget({
				forgetId: memory.forgetId,
				scope: SCOPE,
				reasonCode: "SOURCE_FORGOTTEN",
				roots,
				memoryForgetId: memory.forgetId,
			}),
		) as ForgetReport;
		expect(report).toMatchObject({
			state: "complete",
			complete: true,
			externals: { total: 2, confirmed: 2 },
		});
		expect(
			worldExternals(life, memory.forgetId).every(
				(e) => e.state === "confirmed",
			),
		).toBe(true);
		expect(assertionIds(life)).toEqual(["claim-3"]);
		// Each part is its own World forget: chunked, and reopened one by one.
		const second = `${memory.forgetId}~1`;
		const chunkIds = new Set(
			ops.filter((o) => o.kind === "forget.chunk").map((o) => o.forgetId),
		);
		expect(chunkIds).toEqual(new Set([memory.forgetId, second]));
		expect(
			ops.filter((o) => o.kind === "forget.reopen").map((o) => o.forgetId),
		).toEqual([memory.forgetId, second]);
		expect((await readStatus(life)).status).toBe("ready");
		// A caller id containing the separator could collide with a part: refused.
		expect(
			await lifecycle.acceptForget({
				forgetId: second,
				scope: SCOPE,
				reasonCode: "FORGET_REQUESTED",
				roots: [{ kind: "source", id: keyOf("m2") }],
			}),
		).toEqual({ status: "rejected", reasonCode: "INVALID_INPUT" });
	} finally {
		await life.cleanup();
	}
});
