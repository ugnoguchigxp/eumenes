import { afterEach, expect, test } from "bun:test";
import { ledger, ttl, limits, createResearchRoutes, specKey } from "..";
import {
	type Env,
	NOW,
	activateRoute,
	claimOf,
	coldAdopt,
	setup,
	specOf,
} from "./support";
import { createOperations } from "..";

const envs: Env[] = [];
afterEach(async () => {
	for (const e of envs.splice(0)) await e.close();
});
const mk = async () => {
	const e = await setup();
	envs.push(e);
	return e;
};
let n = 0;
const fakeKey = (
	db: any,
	epoch: number,
	over: Partial<{ enabled: number; now: number }> = {},
) => {
	const key = (++n).toString(16).padStart(64, "0");
	ledger.insertKey(db, {
		epoch,
		key,
		incarnation: crypto.randomUUID(),
		specJson: "{}",
		keywords: "k",
		now: over.now ?? NOW,
	});
	if (over.enabled === 0)
		db.query(
			"UPDATE research_route_keys SET enabled=0 WHERE key=? AND epoch=?",
		).run(key, epoch);
	return key;
};
const count = (env: Env, sql = "SELECT COUNT(*) n FROM research_route_keys") =>
	env.store.read((db) => (db.query(sql).get() as { n: number }).n);
const sweep = (
	env: Env,
	input: Parameters<Env["routes"]["sweepInTransaction"]>[1] = {},
) => env.store.write((db) => env.routes.sweepInTransaction(db, input));

test("D04 clear hides rows at once; physical reclaim runs 100 rows per pass and keeps the recreated key", async () => {
	const env = await mk();
	const ops = createOperations({
		routes: env.routes,
		store: env.store,
		clock: env.clock,
	});
	await env.store.write((db) => {
		for (let i = 0; i < 250; i++) fakeKey(db, 0);
	});
	const cleared = await ops.clear({
		requestId: crypto.randomUUID(),
		expectedEpoch: 0,
	});
	expect(cleared.body).toEqual({ epoch: 1, deletedKeys: 250 });
	expect((ops.list({}).body as any).items).toHaveLength(0);
	const fresh = await env.store.write((db) => fakeKey(db, 1));
	let passes = 0;
	for (;;) {
		const r = await sweep(env, { mode: "epoch" });
		passes++;
		if (!r.hasMore) break;
		expect(r.removed).toBeLessThanOrEqual(100 + 8);
	}
	expect(passes).toBeGreaterThan(1);
	expect(
		count(env, "SELECT COUNT(*) n FROM research_route_keys WHERE epoch=0"),
	).toBe(0);
	expect(
		count(
			env,
			`SELECT COUNT(*) n FROM research_route_keys WHERE key='${fresh}' AND epoch=1`,
		),
	).toBe(1);
});

test("D04 receipts survive clear and its reclaim; expire only after 24h", async () => {
	const env = await mk();
	const ops = createOperations({
		routes: env.routes,
		store: env.store,
		clock: env.clock,
	});
	await ops.clear({ requestId: crypto.randomUUID(), expectedEpoch: 0 });
	await sweep(env, { mode: "epoch" });
	expect(count(env, "SELECT COUNT(*) n FROM research_route_operations")).toBe(
		1,
	);
	await sweep(env);
	expect(count(env, "SELECT COUNT(*) n FROM research_route_operations")).toBe(
		1,
	);
	env.advance(ttl.operationMs + 1);
	await sweep(env);
	expect(count(env, "SELECT COUNT(*) n FROM research_route_operations")).toBe(
		0,
	);
});

test("D04 idle keys are reclaimed, disabled keys never, active used keys stay", async () => {
	const env = await mk();
	const c = await activateRoute(env);
	const [idle, disabled] = await env.store.write((db) => [
		fakeKey(db, 0),
		fakeKey(db, 0, { enabled: 0 }),
	]);
	env.advance(ttl.idleMs + 1000);
	const r = await sweep(env);
	expect(r.removed).toBeGreaterThan(0);
	const has = (k: string) =>
		count(
			env,
			`SELECT COUNT(*) n FROM research_route_keys WHERE key='${k}'`,
		) === 1;
	expect(has(idle)).toBe(false);
	expect(has(disabled)).toBe(true);
	// the activated route was never used, so its idle clock ran out too
	expect(has(c.key)).toBe(false);
	env.advance(100 * 24 * 3600_000);
	await sweep(env);
	expect(has(disabled)).toBe(true);
});

test("D04 a used active route keeps its key; reclaim also removes its learned definitions", async () => {
	const env = await mk();
	const pruned: { remove: string[]; protect: string[] }[] = [];
	const routes = createResearchRoutes({
		clock: env.clock,
		prune: (db, input) => {
			pruned.push(input);
			return env.caps.pruneLearnedInTransaction(db, input);
		},
	});
	const c = await activateRoute(env);
	const k = env.store.read((db) => ledger.getKey(db, 0, c.key)!);
	const version = k.active_version_id!;
	const pkg = env.store.read(
		(db) => ledger.getRevision(db, version)!.package_revision_id,
	);
	await env.store.write((db) => {
		routes.recordRouteUseInTransaction(db, {
			versionId: version,
			fence: {
				key: c.key,
				epoch: 0,
				incarnation: k.incarnation,
				generation: k.generation,
			},
			usedAt: env.clock.now(),
		});
	});
	env.advance(ttl.idleMs - 1000);
	await env.store.write((db) => routes.sweepInTransaction(db));
	expect(
		count(
			env,
			`SELECT COUNT(*) n FROM research_route_keys WHERE key='${c.key}'`,
		),
	).toBe(1);
	env.advance(2000);
	await env.store.write((db) => routes.sweepInTransaction(db));
	expect(
		count(
			env,
			`SELECT COUNT(*) n FROM research_route_keys WHERE key='${c.key}'`,
		),
	).toBe(0);
	expect(pruned.at(-1)!.remove).toContain(pkg);
	expect(pruned.at(-1)!.protect).not.toContain(pkg);
	expect(
		count(env, `SELECT COUNT(*) n FROM capability_revisions WHERE id='${pkg}'`),
	).toBe(0);
});

test("D04 running roots and open drafts protect their route even when idle", async () => {
	const env = await mk();
	const c = await activateRoute(env);
	const k = env.store.read((db) => ledger.getKey(db, 0, c.key)!);
	const held = new Set([k.active_version_id!]);
	const routes = createResearchRoutes({
		clock: env.clock,
		adoption: { protectedBindingsInTransaction: () => [...held] },
	});
	env.advance(ttl.idleMs + 1000);
	await env.store.write((db) => routes.sweepInTransaction(db));
	expect(
		count(
			env,
			`SELECT COUNT(*) n FROM research_route_keys WHERE key='${c.key}'`,
		),
	).toBe(1);
	held.clear();
	await env.store.write((db) => routes.sweepInTransaction(db));
	expect(
		count(
			env,
			`SELECT COUNT(*) n FROM research_route_keys WHERE key='${c.key}'`,
		),
	).toBe(0);
});

test("D04 byte pressure reclaims oldest unprotected keys; all-protected leaves new learning to skip", async () => {
	const env = await mk();
	let external = 0;
	const held = new Set<string>();
	const routes = createResearchRoutes({
		clock: env.clock,
		externalBytes: () => external,
		adoption: { protectedBindingsInTransaction: () => [...held] },
	});
	await env.store.write((db) => [
		fakeKey(db, 0, { now: NOW }),
		fakeKey(db, 0, { now: NOW + 1 }),
	]);
	external = limits.totalBytes; // 64MiB reached
	const lookup = await env.store.write((db) => {
		const s = specOf();
		return routes.lookupInTransaction(db, s, {
			specDigest: specKey(s),
			requestAtMs: NOW,
			expectedDate: "2026-10-11",
			validationPolicyVersion: 1,
		});
	});
	expect(lookup).toMatchObject({
		kind: "lookup",
		reason: "capacity",
		fence: null,
	});
	const r = await env.store.write((db) => routes.sweepInTransaction(db));
	expect(r.removed).toBeGreaterThan(0);
	expect(count(env, "SELECT COUNT(*) n FROM research_route_keys")).toBe(0);
});

test("D04 restart interrupts open drafts and the sweep handlers are replay-safe", async () => {
	const env = await mk();
	const c = await coldAdopt(env);
	expect(env.store.read((db) => ledger.getDraft(db, c.draftId)!.state)).toBe(
		"queued",
	);
	const r = await env.store.write((db) => env.routes.recoverInTransaction(db));
	expect(r.interrupted).toBe(1);
	const d = env.store.read((db) => ledger.getDraft(db, c.draftId)!);
	expect(d).toMatchObject({ state: "interrupted", error_code: "restart" });
	const handlers = env.routes.maintenanceHandlers();
	expect(handlers.map((h) => h.recovery)).toEqual([
		"replay_safe",
		"replay_safe",
	]);
	expect(handlers.map((h) => h.kind)).toEqual([
		"research.sweep",
		"research.clear-sweep",
	]);
});

test("D04 clear interrupts open drafts of the old epoch (late activation impossible)", async () => {
	const env = await mk();
	const c = await coldAdopt(env);
	const ops = createOperations({
		routes: env.routes,
		store: env.store,
		clock: env.clock,
	});
	await ops.clear({ requestId: crypto.randomUUID(), expectedEpoch: 0 });
	const d = env.store.read((db) => ledger.getDraft(db, c.draftId)!);
	expect(d).toMatchObject({
		state: "interrupted",
		error_code: "route_cleared",
	});
});

test("D04 sweep job handler runs a pass in its settle transaction and chains while more remains", async () => {
	const env = await mk();
	await env.store.write((db) => {
		for (let i = 0; i < 120; i++) fakeKey(db, 0);
	});
	const ops = createOperations({
		routes: env.routes,
		store: env.store,
		clock: env.clock,
	});
	await ops.clear({ requestId: crypto.randomUUID(), expectedEpoch: 0 });
	const h = env.routes
		.maintenanceHandlers()
		.find((x) => x.kind === "research.clear-sweep")!;
	for (const h2 of env.routes.maintenanceHandlers()) {
		try {
			env.queue.registerHandler(h2);
		} catch {
			/* already registered */
		}
	}
	const claim = claimOf(h, { mode: "epoch", round: 0 });
	const res = await env.store.write((db) =>
		h.settleInTransaction(db, claim, null, { type: "success", result: null }),
	);
	expect(res).toBe("applied");
	expect(count(env)).toBeLessThan(120);
	const next = env.queue.list({ kind: "research.clear-sweep" }).items;
	expect(next.length).toBeGreaterThan(0);
});
