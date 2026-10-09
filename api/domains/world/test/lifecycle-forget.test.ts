import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStoreError } from "eumenes-memory/sqlite";
import {
	WorldJournalCorruptError,
	appendWorldJournal,
	defaultMemoryPort,
	readWorldJournal,
	verifyWorldJournal,
	type ForgetReport,
	type LifecyclePoint,
} from "..";
import {
	ACCESS,
	NOW,
	SCOPE,
	addMessage,
	claim,
	currentRef,
	entityOp,
	keyOf,
	registerClaim,
} from "./fixture";
import {
	Crash,
	crashHook,
	intakeStates,
	memoryForgetSource,
	openLife,
	reopenLife,
	rows,
	worldExternals,
	type Life,
} from "./lifecycle-fixture";

const must = <T>(value: T | { status: "rejected" }): T => {
	if (typeof value === "object" && value !== null && "status" in value)
		if ((value as { status: unknown }).status === "rejected")
			throw new Error(`rejected: ${JSON.stringify(value)}`);
	return value as T;
};

/** m1 carries two claims (two Memory dependents), m2 one that must survive a forget of m1. */
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
	expect(rows(life, "world_assertion")).toBe(3);
}

const requestFor = (forgetId: string, sourceId = "m1") => ({
	forgetId,
	scope: SCOPE,
	reasonCode: "SOURCE_FORGOTTEN" as const,
	roots: [{ kind: "source" as const, id: keyOf(sourceId) }],
	memoryForgetId: forgetId,
});
const accept = async (
	life: Life,
	forgetId: string,
	sourceId = "m1",
): Promise<ForgetReport> =>
	must(
		await life.lifecycle.acceptForget(requestFor(forgetId, sourceId)),
	) as ForgetReport;

const readyRead = (life: Life) =>
	life.world.read({ access: ACCESS, scope: SCOPE, asOf: NOW });

test("forget flow: intake -> World journal -> World delete -> Memory confirmed -> reopen -> complete", async () => {
	const life = await openLife();
	try {
		await seed(life);
		const memory = await memoryForgetSource(life, keyOf("m1"));
		expect(worldExternals(life, memory.forgetId)).toHaveLength(2);
		expect(
			worldExternals(life, memory.forgetId).every((e) => e.state === "pending"),
		).toBe(true);

		const report = await accept(life, memory.forgetId);
		expect(report).toMatchObject({
			state: "complete",
			complete: true,
			blocked: null,
			externals: { total: 2, confirmed: 2 },
		});
		// Only the claims that stood on m1 are gone; m2's claim and the entity stay.
		expect(rows(life, "world_assertion")).toBe(1);
		expect(rows(life, "world_tombstone")).toBeGreaterThan(0);
		expect(
			worldExternals(life, memory.forgetId).every(
				(e) => e.state === "confirmed",
			),
		).toBe(true);
		expect(rows(life, "world_host_forget_confirmation")).toBe(2);
		// The Scope reopened only after every confirmation.
		expect((await readyRead(life)).status).toBe("ready");
		// One journal entry: opaque ids only, no message text.
		const journal = readWorldJournal(life.journalPath);
		expect(journal).toHaveLength(1);
		expect(journal[0]).toMatchObject({
			forgetId: memory.forgetId,
			memoryForgetId: memory.forgetId,
			reasonCode: "SOURCE_FORGOTTEN",
		});
		expect(readFileSync(life.journalPath, "utf8")).not.toContain("音声");
		// Resending is idempotent.
		expect(await accept(life, memory.forgetId)).toMatchObject({
			state: "complete",
		});
		expect(readWorldJournal(life.journalPath)).toHaveLength(1);
		// A different body under the same id is a conflict, not a second forget.
		expect(
			await life.lifecycle.acceptForget(requestFor(memory.forgetId, "m2")),
		).toEqual({ status: "rejected", reasonCode: "FORGET_CONFLICT" });
	} finally {
		await life.cleanup();
	}
});

const POINTS: LifecyclePoint[] = [
	"accepted",
	"journal_appended",
	"journaled",
	"world_chunk",
	"world_call_done",
	"world_applied",
	"memory_batch",
	"memory_confirmed",
	"before_reopen",
];

for (const point of POINTS) {
	test(`crash at ${point}: the incomplete stage is re-run and the forget completes`, async () => {
		let life = await openLife({ confirmBatch: 1 });
		try {
			await seed(life);
			const memory = await memoryForgetSource(life, keyOf("m1"));
			life = await reopenLife(life, {
				confirmBatch: 1,
				hook: crashHook(point),
			});
			expect((await life.lifecycle.recoverWorld()).status).toBe("open");
			await expect(accept(life, memory.forgetId)).rejects.toBeInstanceOf(Crash);

			// Never complete while an external deletion is unconfirmed.
			const states = intakeStates(life);
			expect(states).toHaveLength(1);
			expect(states[0]!.state).not.toBe("complete");
			if (
				[
					"accepted",
					"journal_appended",
					"journaled",
					"world_chunk",
					"world_call_done",
					"world_applied",
				].includes(point)
			)
				expect(
					worldExternals(life, memory.forgetId).some(
						(e) => e.state !== "confirmed",
					),
				).toBe(true);
			if (point === "memory_batch")
				expect(
					worldExternals(life, memory.forgetId)
						.map((e) => e.state)
						.sort(),
				).toEqual(["confirmed", "pending"]);

			// A new process: the startup gate re-runs whatever stage was incomplete.
			life = await reopenLife(life);
			const recovered = await life.lifecycle.recoverWorld();
			expect(recovered).toMatchObject({ status: "open", restored: false });
			const status = life.lifecycle.forgetStatus(memory.forgetId);
			expect(status).toMatchObject({ state: "complete", complete: true });
			expect(rows(life, "world_assertion")).toBe(1);
			expect(
				worldExternals(life, memory.forgetId).every(
					(e) => e.state === "confirmed",
				),
			).toBe(true);
			expect(readWorldJournal(life.journalPath)).toHaveLength(1);
			expect((await readyRead(life)).status).toBe("ready");
		} finally {
			await life.cleanup();
		}
	});
}

test("A30: more than 500 roots are applied in bounded chunks and resume after a crash between writer callbacks", async () => {
	let life = await openLife({ maxChunksPerCall: 1 });
	try {
		await seed(life);
		const roots = Array.from({ length: 1200 }, (_, i) => ({
			kind: "source" as const,
			id: JSON.stringify(["conversation", "message", `bulk-${i}`, "text"]),
		}));
		roots.push({ kind: "source", id: keyOf("m1") });
		life = await reopenLife(life, {
			maxChunksPerCall: 1,
			hook: crashHook("world_call_done", 2),
		});
		await life.lifecycle.recoverWorld();
		await expect(
			life.lifecycle.acceptForget({
				forgetId: "bulk-forget",
				scope: SCOPE,
				reasonCode: "FORGET_REQUESTED",
				roots,
			}),
		).rejects.toBeInstanceOf(Crash);
		// The gate is closed from the first chunk; the forget is not complete yet.
		expect(intakeStates(life)[0]!.state).toBe("journaled");
		expect(
			(await life.world.apply(registerClaim("late", claim("late-1", []))))
				.status,
		).not.toBe("applied");

		life = await reopenLife(life, { maxChunksPerCall: 1 });
		const recovered = await life.lifecycle.recoverWorld();
		expect(recovered.status).toBe("open");
		expect(life.lifecycle.forgetStatus("bulk-forget")).toMatchObject({
			state: "complete",
			complete: true,
			externals: null,
		});
		expect(rows(life, "world_assertion")).toBe(1);
		expect(rows(life, "world_tombstone")).toBeGreaterThanOrEqual(1201);
		expect((await readyRead(life)).status).toBe("ready");
	} finally {
		await life.cleanup();
	}
});

test("forget works with World OFF: content is deleted, the report is honest, the flag stays OFF", async () => {
	const life = await openLife();
	try {
		await seed(life);
		const memory = await memoryForgetSource(life, keyOf("m1"));
		await life.world.setEnabled(false);
		const report = await accept(life, memory.forgetId);
		expect(report.complete).toBe(true);
		expect(rows(life, "world_assertion")).toBe(1);
		expect(life.world.status()).toMatchObject({ enabled: false });
		// Reads stay blocked while World is OFF; forgetting never needed it.
		expect(await readyRead(life)).toEqual({
			status: "blocked",
			reasonCode: "WORLD_DISABLED",
		});
	} finally {
		await life.cleanup();
	}
});

for (const kind of ["unavailable", "not_permitted"] as const) {
	test(`Memory ${kind}: World content is deleted but the forget stays pending, never complete`, async () => {
		let life = await openLife({
			memory:
				kind === "unavailable"
					? {
							receipt: () => {
								throw new MemoryStoreError("CORRUPT_ROW");
							},
						}
					: { record: () => "not_permitted" },
		});
		try {
			await seed(life);
			const memory = await memoryForgetSource(life, keyOf("m1"));
			const report = await accept(life, memory.forgetId);
			expect(report.complete).toBe(false);
			expect(report.state).toBe("world_applied");
			expect(report.blocked).toBe(
				kind === "unavailable" ? "MEMORY_UNAVAILABLE" : "MEMORY_NOT_PERMITTED",
			);
			// World's side is done and verified ...
			expect(rows(life, "world_assertion")).toBe(1);
			// ... but the Scope is not reopened and Memory still shows pending.
			expect((await readyRead(life)).status).toBe("blocked");
			expect(
				worldExternals(life, memory.forgetId).every(
					(e) => e.state === "pending",
				),
			).toBe(true);
			// Memory is back (a new process with the real port): the same forget completes.
			life = await reopenLife(life);
			await life.lifecycle.recoverWorld();
			expect(life.lifecycle.forgetStatus(memory.forgetId)).toMatchObject({
				state: "complete",
			});
			expect((await readyRead(life)).status).toBe("ready");
		} finally {
			await life.cleanup();
		}
	});
}

test("a partial confirmation is not complete: one confirmed external, the next refused", async () => {
	let recorded = 0;
	const life = await openLife({
		confirmBatch: 1,
		memory: {
			record: (db, access, atMs, input) => {
				recorded += 1;
				if (recorded === 2) return "missing";
				return defaultMemoryPort.record(db, access, atMs, input);
			},
		},
	});
	try {
		await seed(life);
		const memory = await memoryForgetSource(life, keyOf("m1"));
		const report = await accept(life, memory.forgetId);
		expect(report).toMatchObject({
			complete: false,
			state: "world_applied",
			blocked: "MEMORY_MISSING",
			externals: { total: 2, confirmed: 1 },
		});
		expect(
			worldExternals(life, memory.forgetId)
				.map((e) => e.state)
				.sort(),
		).toEqual(["confirmed", "pending"]);
		expect(
			life.store.read(
				(db) =>
					db
						.query(
							"SELECT COUNT(*) AS n FROM world_host_forget_confirmation WHERE state = 'confirmed'",
						)
						.get() as { n: number },
			).n,
		).toBe(1);
		expect((await readyRead(life)).status).toBe("blocked");
		// The second pass confirms the rest.
		expect(await life.lifecycle.resumeForget(memory.forgetId)).toMatchObject({
			complete: true,
		});
	} finally {
		await life.cleanup();
	}
});

test("an unknown Memory forget is never treated as 'nothing to confirm'", async () => {
	const life = await openLife();
	try {
		await seed(life);
		const report = must(
			await life.lifecycle.acceptForget({
				forgetId: "x-1",
				scope: SCOPE,
				reasonCode: "SOURCE_FORGOTTEN",
				roots: [{ kind: "source", id: keyOf("m1") }],
				memoryForgetId: "forget:missing",
			}),
		) as ForgetReport;
		expect(report).toMatchObject({
			complete: false,
			state: "world_applied",
			blocked: "MEMORY_RECEIPT_MISSING",
		});
	} finally {
		await life.cleanup();
	}
});

test("a corrupt journal keeps World closed and a pending forget is not deleted without its journal entry", async () => {
	const life = await openLife();
	try {
		await seed(life);
		const memory = await memoryForgetSource(life, keyOf("m1"));
		writeFileSync(life.journalPath, "not json\n");
		const report = await accept(life, memory.forgetId);
		expect(report).toMatchObject({
			state: "pending",
			complete: false,
			blocked: "JOURNAL_CORRUPT",
		});
		expect(life.gate.isOpen()).toBe(false);
		expect(rows(life, "world_assertion")).toBe(3);
		expect((await readyRead(life)).status).toBe("blocked");
		expect(await readyRead(life)).toMatchObject({
			reasonCode: "WORLD_RECOVERY_REQUIRED",
		});
	} finally {
		await life.cleanup();
	}
});

test("Memory confirmation is always per externalId, only for the closure of this forget (A38)", async () => {
	const calls: { forgetId: string; externalId: string; state: string }[] = [];
	const life = await openLife({
		memory: {
			record: (db, access, atMs, input) => {
				calls.push({ ...input });
				return defaultMemoryPort.record(db, access, atMs, input);
			},
		},
	});
	try {
		await seed(life);
		const memory = await memoryForgetSource(life, keyOf("m1"));
		const ours = new Set(
			worldExternals(life, memory.forgetId).map((e) => e.externalId),
		);
		expect(ours.size).toBe(2);
		await accept(life, memory.forgetId);
		expect(calls).toHaveLength(2);
		for (const call of calls) {
			expect(call.externalId).toBeTruthy();
			expect(ours.has(call.externalId)).toBe(true);
			expect(call.state).toBe("confirmed");
			expect(call.forgetId).toBe(memory.forgetId);
		}
		// claim-3 stands on m2 and was never part of this forget.
		expect(rows(life, "world_host_forget_confirmation")).toBe(2);
	} finally {
		await life.cleanup();
	}
});

test("World journal: chained, idempotent per forgetId, and any damage is detected", () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-world-journal-"));
	const path = join(dir, "nested", "journal.jsonl");
	try {
		expect(readWorldJournal(path)).toEqual([]);
		const draft = (forgetId: string) => ({
			forgetId,
			memoryForgetId: null,
			principal: "p",
			scopeKey: "s",
			reasonCode: "FORGET_REQUESTED" as const,
			roots: [{ kind: "source" as const, id: `k-${forgetId}`, revision: 1 }],
		});
		const a = appendWorldJournal(path, draft("a"));
		const b = appendWorldJournal(path, draft("b"));
		expect(a.seq).toBe(1);
		expect(b).toMatchObject({ seq: 2, prevHash: a.hash });
		// The same forgetId returns the existing entry; nothing is appended.
		expect(appendWorldJournal(path, draft("a"))).toEqual(a);
		expect(readWorldJournal(path)).toEqual([a, b]);
		verifyWorldJournal([a, b]);
		expect(() => verifyWorldJournal([b])).toThrow(WorldJournalCorruptError);
		expect(() =>
			verifyWorldJournal([{ ...a, reasonCode: "SOURCE_FORGOTTEN" }, b]),
		).toThrow(WorldJournalCorruptError);
		// An entry carries ids only.
		expect(Object.keys(a).sort()).toEqual(
			[
				"forgetId",
				"hash",
				"journalFormat",
				"memoryForgetId",
				"prevHash",
				"principal",
				"reasonCode",
				"roots",
				"scopeKey",
				"seq",
			].sort(),
		);
		// A line removed from the middle or a swap breaks the chain.
		const lines = readFileSync(path, "utf8").trimEnd().split("\n");
		writeFileSync(path, `${lines[1]}\n${lines[0]}\n`);
		expect(() => readWorldJournal(path)).toThrow(WorldJournalCorruptError);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
