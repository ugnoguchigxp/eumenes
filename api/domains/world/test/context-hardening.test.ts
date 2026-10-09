/**
 * Review round 1 hardening of the Context Broker: a refused Memory release
 * never fails the caller's transaction and is retried by a sweep, usage
 * receipts removed by a forget take their Memory dependents with them, the
 * rendered (escaped) block is what the shared budget is measured on, and a
 * busy writer is a retryable verdict. Real host store, real Memory and World.
 */
import { expect, test } from "bun:test";
import { WriterBusyError } from "../../../infrastructure/sqlite";
import {
	CONTEXT_TOTAL_BYTES,
	allocateContextBudget,
	createWorldContextBroker,
	type ContextPrepareInput,
	type ContextPrepared,
	type PreparedWorldContext,
} from "..";
import { goalRenderedBytes } from "../service/context-render";
import {
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
	withHarness,
	worldEdges,
	type Harness,
} from "./fixture";
import { openLife } from "./lifecycle-fixture";

const prepareInput = (
	runId: string,
	over: Partial<ContextPrepareInput> = {},
): ContextPrepareInput => ({
	runId,
	conversationId: "c1",
	jobId: `job-${runId}`,
	attempt: 1,
	generation: 0,
	reservedBytes: 0,
	nowMs: NOW,
	...over,
});
const settleInput = (runId: string) => ({
	runId,
	conversationId: "c1",
	jobId: `job-${runId}`,
	attempt: 1,
	generation: 0,
	inference: { requestId: `req-${runId}`, attemptId: `att-${runId}` },
	nowMs: NOW,
});

function broker(
	h: Pick<Harness, "store" | "world">,
	over: { totalBytes?: number } = {},
) {
	return createWorldContextBroker({
		store: h.store,
		world: h.world,
		clock: () => NOW,
		purpose: PURPOSE,
		...over,
	});
}

const ready = (prepared: ContextPrepared) => {
	if (prepared.status !== "ready") throw new Error(JSON.stringify(prepared));
	return prepared;
};
/** Distinct Memory dependents of Slices (one dependent has an edge per input). */
const sliceEdges = (h: Pick<Harness, "store">) => [
	...new Set(
		(worldEdges(h as Harness) as { dependent_id: string }[])
			.map((edge) => edge.dependent_id)
			.filter((id) => id.includes(":w1s-")),
	),
];
const sliceHostRows = (h: Pick<Harness, "store">) =>
	h.store.read((db) =>
		db
			.query(
				"SELECT external_id, release_pending FROM world_host_dependent WHERE external_id LIKE 'w1s-%'",
			)
			.all(),
	) as { external_id: string; release_pending: number }[];

const adoptOne = async (h: Pick<Harness, "world">, id: string) =>
	expect(
		(
			await h.world.apply(
				request(`ad-${id}`, {
					kind: "assertion.transition",
					plan: adoptPlan(id, 1),
				}),
			)
		).status,
	).toBe("applied");

async function seedAdopted(h: Harness, value = "音声サービスは9月から") {
	await h.world.apply(entityOp());
	await addMessage(h, "m1", value);
	expect(
		(
			await h.world.apply(
				registerClaim("c-1", claim("claim-1", [currentRef(h, "m1")])),
			)
		).status,
	).toBe("applied");
	await adoptOne(h, "claim-1");
}

const BLOCK_DELETES =
	"CREATE TRIGGER block_dependency_delete BEFORE DELETE ON memory_dependency BEGIN SELECT RAISE(ABORT, 'memory_tombstoned'); END";
const UNBLOCK = "DROP TRIGGER IF EXISTS block_dependency_delete";

test("a refused Memory release never fails the settle/cancel transaction; the host rows wait for a retry sweep", async () => {
	await withHarness(async (h) => {
		await seedAdopted(h);
		const b = broker(h);
		ready(
			await h.store.write((db) =>
				b.prepareInTransaction(db, prepareInput("r1")),
			),
		);
		expect(sliceEdges(h)).toHaveLength(1);
		await h.store.write((db) => db.exec(BLOCK_DELETES));

		// Memory store error inside release: the caller's transaction still commits.
		await h.store.write((db) => {
			db.query("INSERT INTO host_probe (n) VALUES (7)").run();
			b.releaseInTransaction(db, "r1", "c1");
		});
		expect(
			h.store.read((db) => db.query("SELECT n FROM host_probe").all()),
		).toEqual([{ n: 7 }]);
		// Nothing was lost: the edge and the host row stay, marked for retry.
		expect(sliceEdges(h)).toHaveLength(1);
		expect(sliceHostRows(h)).toEqual([
			expect.objectContaining({ release_pending: 1 }),
		]);
		// Sweeping while Memory still refuses changes nothing and does not throw.
		expect(await b.sweepPendingReleases()).toEqual({
			released: 0,
			stillPending: 1,
		});
		expect(sliceHostRows(h)).toHaveLength(1);

		await h.store.write((db) => db.exec(UNBLOCK));
		expect(await b.sweepPendingReleases()).toEqual({
			released: 1,
			stillPending: 0,
		});
		expect(sliceEdges(h)).toHaveLength(0);
		expect(sliceHostRows(h)).toHaveLength(0);
		// Idempotent.
		expect(await b.sweepPendingReleases()).toEqual({
			released: 0,
			stillPending: 0,
		});
	});
});

test("a forget removes the usage receipts AND their Memory dependents; a refusal keeps them tracked for the sweep", async () => {
	for (const refuse of [false, true]) {
		const life = await openLife();
		try {
			expect((await life.lifecycle.recoverWorld()).status).toBe("open");
			await seedAdopted(life);
			await addMessage(life, "m2", "別の話題の発言。");
			await life.world.apply(
				registerClaim("c-3", claim("claim-3", [currentRef(life, "m2")])),
			);
			await adoptOne(life, "claim-3");
			const b = broker(life);
			const context = ready(
				await life.store.write((db) =>
					b.prepareInTransaction(db, prepareInput("r1")),
				),
			).context;
			await life.store.write((db) =>
				b.recordUsageInTransaction(db, settleInput("r1"), context),
			);
			expect(sliceEdges(life)).toHaveLength(1);
			expect(
				(
					life.store.read((db) =>
						db.query("SELECT COUNT(*) AS n FROM world_host_usage").get(),
					) as { n: number }
				).n,
			).toBe(1);
			if (refuse) await life.store.write((db) => db.exec(BLOCK_DELETES));

			const report = await life.lifecycle.acceptForget({
				forgetId: `forget-${refuse}`,
				scope: SCOPE,
				reasonCode: "FORGET_REQUESTED",
				roots: [{ kind: "source", id: keyOf("m1") }],
			});
			expect(report).toMatchObject({ complete: true });
			// The receipts are gone either way (what they stood on is invalidated).
			expect(
				(
					life.store.read((db) =>
						db.query("SELECT COUNT(*) AS n FROM world_host_usage").get(),
					) as { n: number }
				).n,
			).toBe(0);
			if (!refuse) {
				expect(sliceEdges(life)).toHaveLength(0);
				expect(sliceHostRows(life)).toHaveLength(0);
			} else {
				expect(sliceEdges(life)).toHaveLength(1);
				expect(sliceHostRows(life)).toEqual([
					expect.objectContaining({ release_pending: 1 }),
				]);
				await life.store.write((db) => db.exec(UNBLOCK));
				expect(await b.sweepPendingReleases()).toEqual({
					released: 1,
					stillPending: 0,
				});
				expect(sliceEdges(life)).toHaveLength(0);
				expect(sliceHostRows(life)).toHaveLength(0);
			}
		} finally {
			await life.cleanup();
		}
	}
});

test("usage pruning keeps the dependents registered exactly as long as the receipt (KEEP_USAGE_PER_SCOPE)", async () => {
	await withHarness(async (h) => {
		await seedAdopted(h);
		const b = createWorldContextBroker({
			store: h.store,
			world: h.world,
			clock: () => NOW,
			purpose: PURPOSE,
			keepUsagePerScope: 1,
		});
		for (const runId of ["r1", "r2"]) {
			const context = ready(
				await h.store.write((db) =>
					b.prepareInTransaction(db, prepareInput(runId)),
				),
			).context;
			await h.store.write((db) =>
				b.recordUsageInTransaction(
					db,
					{ ...settleInput(runId), nowMs: NOW + (runId === "r2" ? 1 : 0) },
					context,
				),
			);
		}
		// r1 was pruned with its dependents; r2's receipt and dependent remain.
		const usage = h.store.read((db) =>
			db.query("SELECT run_id FROM world_host_usage").all(),
		);
		expect(usage).toEqual([{ run_id: "r2" }]);
		expect(sliceEdges(h)).toHaveLength(1);
		expect(sliceHostRows(h)).toHaveLength(1);
	});
});

// --- 5. the budget is enforced on the rendered (escaped) block ------------------------------

const hostile = "<".repeat(300);
async function seedHostile(h: Harness) {
	await h.world.apply(entityOp());
	await addMessage(h, "m1", "x");
	const c = claim("claim-1", [currentRef(h, "m1")], {
		payload: { kind: "value", value: { kind: "string", value: hostile } },
	});
	expect((await h.world.apply(registerClaim("c-1", c))).status).toBe("applied");
	await adoptOne(h, "claim-1");
}
const utf8 = (text: string) => new TextEncoder().encode(text).length;

test("escape expansion cannot push the block past the shared total: blocked world_overflow, or a block that fits", async () => {
	await withHarness(async (h) => {
		await seedHostile(h);
		const b = broker(h);
		// Roomy: ready, and the measured block is what the context records.
		const roomy = ready(
			await h.store.write((db) =>
				b.prepareInTransaction(db, prepareInput("r-ok")),
			),
		);
		expect(roomy.context.budget.blockBytes).toBe(utf8(roomy.block));
		// The 300 '<' became < (6 bytes each): the block is far larger than the raw slice.
		expect(roomy.context.budget.blockBytes).toBeGreaterThan(
			roomy.context.slice.budget.usedBytes + 1000,
		);
		const needed = roomy.context.budget.blockBytes;

		// A limit just under what the escaped block needs: the raw slice would still
		// fit its own cap, but the rendered block does not -> overflow, not a bigger input.
		const tight = prepareInput("r-tight", {
			reservedBytes: CONTEXT_TOTAL_BYTES - (needed - 400),
		});
		const blocked = await h.store.write((db) =>
			b.prepareInTransaction(db, tight),
		);
		expect(blocked).toEqual({ status: "blocked", reason: "world_overflow" });
		// Refused means nothing registered for it.
		expect(sliceEdges(h)).toHaveLength(1);

		// Whatever the limit, a ready block never exceeds total - reserved.
		for (const spare of [0, 50, 300, 2000]) {
			const reservedBytes = CONTEXT_TOTAL_BYTES - needed - spare;
			const out = await h.store.write((db) =>
				b.prepareInTransaction(
					db,
					prepareInput(`r-${spare}`, { reservedBytes }),
				),
			);
			if (out.status === "ready")
				expect(out.context.budget.blockBytes).toBeLessThanOrEqual(
					CONTEXT_TOTAL_BYTES - reservedBytes,
				);
			else expect(out).toEqual({ status: "blocked", reason: "world_overflow" });
		}
	});
});

test("goal bytes are measured on the escaped JSON too", () => {
	const goal = { desiredState: "<".repeat(200), priority: 1 };
	// 200 '<' are 1200 bytes once escaped: more than the raw JSON ever shows.
	expect(goalRenderedBytes(goal)).toBeGreaterThan(1200);
	const base = {
		totalBytes: CONTEXT_TOTAL_BYTES,
		reservedBytes: 0,
		sliceCapBytes: 8192,
	};
	// Raw it would fit the goal cap (1024); rendered it does not, so it is dropped whole.
	expect(
		allocateContextBudget({ ...base, goalBytes: [goalRenderedBytes(goal)] }),
	).toMatchObject({ ok: true, goalCount: 0, goalBytes: 0 });
	expect(allocateContextBudget({ ...base, goalBytes: [] })).toMatchObject({
		ok: true,
		blockLimitBytes: CONTEXT_TOTAL_BYTES,
	});
});

// --- 7(e) retryable pre-send verdict ---------------------------------------------------------

test("a busy or closing Writer is a retryable verdict, any other failure stays a hard no", async () => {
	await withHarness(async (h) => {
		await seedAdopted(h);
		const b = broker(h);
		const context: PreparedWorldContext = ready(
			await h.store.write((db) =>
				b.prepareInTransaction(db, prepareInput("r1")),
			),
		).context;
		const failing = (error: Error) =>
			createWorldContextBroker({
				store: {
					...h.store,
					write: async () => {
						throw error;
					},
				} as unknown as Harness["store"],
				world: h.world,
				purpose: PURPOSE,
			});
		expect(
			await failing(new WriterBusyError()).checkBeforeSend(context),
		).toEqual({
			ok: false,
			reason: "world_check_unavailable",
			retryable: true,
		});
		expect(
			await failing(new Error("database_closing")).checkBeforeSend(context),
		).toEqual({
			ok: false,
			reason: "world_check_unavailable",
			retryable: true,
		});
		expect(await failing(new Error("boom")).checkBeforeSend(context)).toEqual({
			ok: false,
			reason: "world_check_unavailable",
		});
	});
});
