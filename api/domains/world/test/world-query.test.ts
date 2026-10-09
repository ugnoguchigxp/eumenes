/**
 * P5-01 world.query on a REAL host store (temp file, WAL, single writer,
 * production migrations, real conversation SourceAdapter). Claims are
 * fixture-grade manual registrations; no model is involved.
 * A14 (directions), A15 (bounds), A16 (resources/Goal/Gaps), A47 (Gap -> Task).
 */
import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";
import { createGoalsService } from "../../goals";
import {
	WORLD_QUERY_LIMITS,
	WORLD_QUERY_MODES,
	createWorldHostGate,
	createWorldQuery,
	createWorldQueryTool,
	gapTaskKey,
	gapTaskRequestId,
	registerWorldQuery,
	worldQueryToolSchema,
	type GapTaskDecision,
	type GapTaskPort,
	type GapTaskRequest,
	type WorldQueryContext,
	type WorldQueryOptions,
	type WorldQueryResult,
} from "..";
import { NOW, PURPOSE, SCOPE, withHarness, type Harness } from "./fixture";
import { messageRef, relate } from "./query-fixture";

const ctx: WorldQueryContext = {
	principal: SCOPE.principal,
	scopeKeys: [SCOPE.scopeKey],
};
const open = (h: Harness, over: Partial<WorldQueryOptions> = {}) =>
	createWorldQuery({
		store: h.store,
		world: h.world,
		purpose: PURPOSE,
		now: () => NOW,
		...over,
	});
const ok = (result: WorldQueryResult) => {
	if (result.status !== "ok") throw new Error(JSON.stringify(result));
	return result;
};

/** Every table a query could conceivably write. */
function dump(h: Harness): Record<string, unknown[]> {
	return h.store.read((db) => {
		const tables = db
			.query(
				`SELECT name FROM sqlite_master WHERE type = 'table'
				AND (name LIKE 'world_%' OR name LIKE 'memory_%' OR name LIKE 'goal%'
					OR name LIKE 'host_%' OR name LIKE 'task%' OR name LIKE 'queue%')
				ORDER BY name`,
			)
			.all() as { name: string }[];
		return Object.fromEntries(
			tables.map(({ name }) => [
				name,
				db.query(`SELECT * FROM "${name}"`).all(),
			]),
		);
	});
}
const count = (h: Harness, table: string): number =>
	(
		h.store.read((db) =>
			db.query(`SELECT COUNT(*) AS n FROM ${table}`).get(),
		) as { n: number }
	).n;

/** A -causes-> B -causes-> C, C -causes-> A (feedback), A correlates D, S depends_on R1,R2. */
async function seedGraph(h: Harness) {
	const ref = await messageRef(h);
	await relate(h, ref, "e1", "A", "B", "causes");
	await relate(h, ref, "e2", "B", "C", "causes");
	await relate(h, ref, "e3", "C", "A", "causes");
	await relate(h, ref, "e4", "A", "D", "correlates_with");
	await relate(h, ref, "e5", "S", "R1", "depends_on");
	await relate(h, ref, "e6", "S", "R2", "depends_on");
	return ref;
}

const NO_OVERLAY = [
	{ overlayId: "o1", addEdges: [], removeEdgeIds: [] },
	{ overlayId: "o2", addEdges: [], removeEdgeIds: [] },
];
const BASE: Record<string, Record<string, unknown>> = {
	snapshot: { mode: "snapshot" },
	relevance: { mode: "relevance", entityId: "A" },
	influence: { mode: "influence", entityId: "A" },
	dependencies: { mode: "dependencies", entityId: "S" },
	scenarios: { mode: "scenarios", entityId: "A", overlays: NO_OVERLAY },
	gaps: { mode: "gaps" },
};

/** A fake of the HOST's Task entry: records what it created, decides by delegation. */
function taskPort(
	behaviour: {
		delegated?: boolean | ((request: GapTaskRequest) => boolean);
		throwOnCall?: number;
	} = {},
) {
	const created: string[] = [];
	const calls: GapTaskRequest[] = [];
	const port: GapTaskPort = {
		linkInTransaction(db: Database, request): GapTaskDecision {
			calls.push(request);
			const granted =
				typeof behaviour.delegated === "function"
					? behaviour.delegated(request)
					: (behaviour.delegated ?? false);
			if (!granted) return { status: "denied", reason: "no_delegation" };
			if (behaviour.throwOnCall === calls.length) throw new Error("port_boom");
			// The Task row lives in the host's transaction, like the real thing.
			db.query("INSERT INTO host_probe (n) VALUES (1)").run();
			created.push(request.dedupeKey);
			return { status: "created", taskRef: `task-${created.length}` };
		},
	};
	return { port, created, calls };
}

test("the surface is the six enumerated modes; unknown mode, free text and extra keys are rejected", async () => {
	expect([...WORLD_QUERY_MODES]).toEqual([
		"snapshot",
		"relevance",
		"influence",
		"dependencies",
		"scenarios",
		"gaps",
	]);
	await withHarness(async (h) => {
		await seedGraph(h);
		const q = open(h);
		const before = dump(h);
		for (const bad of [
			{ mode: "sql", query: "SELECT * FROM world_assertion" },
			{ mode: "mutate", edge: { from: "A", to: "B" } },
			{ mode: "" },
			{},
			{ mode: 7 },
		])
			expect(await q.query(ctx, bad)).toEqual({
				status: "rejected",
				code: "unknown_mode",
			});
		for (const bad of [
			null,
			"snapshot",
			[],
			{ mode: "snapshot", sql: "DROP TABLE world_entity" },
			{ mode: "snapshot", principal: "someone-else" },
			{ mode: "relevance" },
			{ mode: "relevance", entityId: "" },
			{ mode: "relevance", entityId: 3 },
			{ mode: "influence", entityId: "A", direction: "sideways" },
			{ mode: "relevance", entityId: "A", goalId: "g1" },
			{ mode: "snapshot", linkGaps: true },
			{ mode: "scenarios", entityId: "A", overlays: [NO_OVERLAY[0]] },
		])
			expect(await q.query(ctx, bad)).toEqual({
				status: "rejected",
				code: "invalid_request",
			});
		expect(
			await q.query(ctx, {
				mode: "relevance",
				entityId: "A",
				pad: "x".repeat(WORLD_QUERY_LIMITS.requestBytes),
			}),
		).toEqual({ status: "rejected", code: "limit_exceeded" });
		const cyclic: Record<string, unknown> = { mode: "snapshot" };
		cyclic.self = cyclic;
		expect(await q.query(ctx, cyclic)).toEqual({
			status: "rejected",
			code: "invalid_request",
		});
		// Nothing was written by any of the rejected requests.
		expect(dump(h)).toEqual(before);
	});
});

test("A14 causal direction: A->B->C propagates; correlation does not; reverse lists causes without flipping edges; the cycle ends", async () => {
	await withHarness(async (h) => {
		await seedGraph(h);
		const q = open(h);
		const forward = ok(
			await q.query(ctx, { mode: "influence", entityId: "A" }),
		);
		if (forward.result.mode !== "influence") throw new Error("mode");
		const reached = forward.result.influence.paths.map((p) =>
			p.nodes.join(">"),
		);
		expect(reached).toContain("A>B");
		expect(reached).toContain("A>B>C");
		// Correlation (A~D) is never an effect; the cycle (C->A) is cut, not looped.
		expect(reached.some((path) => path.includes("D"))).toBe(false);
		expect(forward.result.influence.skipped.map((s) => s.edgeId)).toContain(
			"e3",
		);
		expect(forward.completeness).toBe("complete");
		// Evidence and conditions of every named claim come with the result.
		const basisIds = forward.basis.map((b) => b.id);
		expect(basisIds).toEqual(expect.arrayContaining(["e1", "e2"]));
		expect(forward.basis.find((b) => b.id === "e1")).toMatchObject({
			relation: { kind: "causes", objectId: "B" },
			condition: { kind: "explicitly_unconditional" },
			sources: [{ namespace: "conversation", kind: "message", id: "m1" }],
		});

		const reverse = ok(
			await q.query(ctx, {
				mode: "influence",
				entityId: "C",
				direction: "reverse",
			}),
		);
		if (reverse.result.mode !== "influence") throw new Error("mode");
		expect(reverse.result.influence.direction).toBe("reverse");
		for (const path of reverse.result.influence.paths)
			for (const edge of path.edges) {
				// The edge keeps its stored direction even when walked backwards.
				const stored = { e1: ["A", "B"], e2: ["B", "C"], e3: ["C", "A"] }[
					edge.id as "e1"
				];
				expect([edge.from, edge.to]).toEqual(stored);
			}

		const relevance = ok(
			await q.query(ctx, { mode: "relevance", entityId: "A" }),
		);
		if (relevance.result.mode !== "relevance") throw new Error("mode");
		// Relevance lists the correlated entity but marks it as no causal propagation.
		expect(
			relevance.result.relevance.entities.map((e) => e.entityId),
		).toContain("D");
		expect(
			relevance.result.relevance.relations.find((r) => r.edgeId === "e4"),
		).toMatchObject({ causalPropagation: false });
	});
});

test("A16 dependencies: resource states come from the host only; available never confirms success; unknown stays unknown", async () => {
	await withHarness(async (h) => {
		await seedGraph(h);
		const dependencies = async (
			states: {
				entityId: string;
				state: "available" | "unavailable" | "unknown";
			}[],
			request: Record<string, unknown> = BASE.dependencies!,
		) => {
			const result = ok(
				await open(h, { resourceStates: () => states }).query(ctx, request),
			);
			if (result.result.mode !== "dependencies") throw new Error("mode");
			return result.result.dependencies;
		};
		// No host knowledge: everything is unknown, nothing is "available".
		const none = await dependencies([]);
		expect(none.outcome).toBe("unknown");
		expect(none.successConfirmed).toBe(false);
		expect(none.unknown.sort()).toEqual(["R1", "R2"]);
		expect(
			(await dependencies([{ entityId: "R1", state: "unavailable" }])).outcome,
		).toBe("unsatisfied");
		const all = await dependencies([
			{ entityId: "R1", state: "available" },
			{ entityId: "R2", state: "available" },
		]);
		expect(all.outcome).toBe("all_available");
		// Availability is not success.
		expect(all.successConfirmed).toBe(false);
		// A request cannot assert resource states.
		expect(
			await open(h).query(ctx, {
				...BASE.dependencies,
				resourceStates: [{ entityId: "R1", state: "available" }],
			}),
		).toEqual({ status: "rejected", code: "invalid_request" });
	});
});

test("scenarios: overlays are hypothetical copies; nothing is stored; a malformed overlay is rejected", async () => {
	await withHarness(async (h) => {
		await seedGraph(h);
		const q = open(h);
		const before = dump(h);
		const hypo = {
			id: "h1",
			revision: 1,
			from: "A",
			to: "D",
			relation: "causes",
			status: "active",
			causalEligible: true,
			condition: { kind: "explicitly_unconditional", adoptionEvidenceId: "x" },
		};
		const result = ok(
			await q.query(ctx, {
				mode: "scenarios",
				entityId: "A",
				overlays: [
					{ overlayId: "adds", addEdges: [hypo], removeEdgeIds: [] },
					{ overlayId: "cuts", addEdges: [], removeEdgeIds: ["e1"] },
				],
			}),
		);
		if (result.result.mode !== "scenarios") throw new Error("mode");
		expect(result.result.hypothetical).toBe(true);
		expect(result.result.scenarios.quantitativeEffect).toBe("not_computed");
		expect(
			result.result.scenarios.comparison.onlyA.some((key) =>
				key.includes("h1@1"),
			),
		).toBe(true);
		expect(result.executionPermission).toBe("none");
		// The hypothetical edge is NOT in the ledger or the projection afterwards.
		expect(dump(h)).toEqual(before);
		const snapshot = ok(await q.query(ctx, { mode: "snapshot" }));
		if (snapshot.result.mode !== "snapshot") throw new Error("mode");
		expect(snapshot.result.entries.map((e) => e.id)).not.toContain("h1");

		for (const bad of [
			{ overlayId: "bad", addEdges: [{ id: "x" }], removeEdgeIds: [] },
		])
			expect(
				await q.query(ctx, {
					mode: "scenarios",
					entityId: "A",
					overlays: [bad, NO_OVERLAY[1]],
				}),
			).toEqual({ status: "rejected", code: "invalid_request" });
		// The same overlay id twice is not a comparison.
		expect(
			await q.query(ctx, {
				mode: "scenarios",
				entityId: "A",
				overlays: [NO_OVERLAY[0], NO_OVERLAY[0]],
			}),
		).toEqual({ status: "rejected", code: "invalid_request" });
	});
});

test("A15 every mode: each bound is accepted AT its limit and rejected one above; zero is invalid", async () => {
	await withHarness(async (h) => {
		await seedGraph(h);
		const q = open(h);
		const budget = WORLD_QUERY_LIMITS.budget;
		for (const [mode, base] of Object.entries(BASE))
			for (const [key, max] of Object.entries(budget)) {
				const at = await q.query(ctx, { ...base, budget: { [key]: max } });
				expect([mode, key, at.status]).toEqual([mode, key, "ok"]);
				expect(
					await q.query(ctx, { ...base, budget: { [key]: max + 1 } }),
				).toEqual({ status: "rejected", code: "limit_exceeded" });
				expect(await q.query(ctx, { ...base, budget: { [key]: 0 } })).toEqual({
					status: "rejected",
					code: "invalid_request",
				});
			}
		// 501 candidates / 501 expansions are the A15 boundary cases.
		for (const key of ["candidates", "expansions"])
			expect(
				await q.query(ctx, { ...BASE.relevance, budget: { [key]: 501 } }),
			).toEqual({ status: "rejected", code: "limit_exceeded" });
		const many = Array.from({ length: 11 }, (_, i) => `n${i}`);
		for (const mode of ["snapshot", "gaps"])
			expect(await q.query(ctx, { mode, entityIds: many })).toEqual({
				status: "rejected",
				code: "limit_exceeded",
			});
		expect(
			ok(await q.query(ctx, { mode: "snapshot", entityIds: many.slice(0, 10) }))
				.status,
		).toBe("ok");
		expect(
			await q.query(ctx, { mode: "snapshot", entityIds: ["A", "A"] }),
		).toEqual({ status: "rejected", code: "invalid_request" });
		expect(await q.query(ctx, { mode: "snapshot", depth: 5 })).toEqual({
			status: "rejected",
			code: "limit_exceeded",
		});
		expect(ok(await q.query(ctx, { mode: "snapshot", depth: 4 })).status).toBe(
			"ok",
		);
		expect(
			await q.query(ctx, { ...BASE.relevance, entityId: "é".repeat(129) }),
		).toEqual({ status: "rejected", code: "limit_exceeded" });
		expect(
			ok(await q.query(ctx, { ...BASE.relevance, entityId: "é".repeat(128) }))
				.status,
		).toBe("ok");
		const edge = (i: number) => ({ id: `h${i}` });
		expect(
			await q.query(ctx, {
				...BASE.scenarios,
				overlays: [
					{
						overlayId: "o1",
						addEdges: Array.from({ length: 101 }, (_, i) => edge(i)),
						removeEdgeIds: [],
					},
					NO_OVERLAY[1],
				],
			}),
		).toEqual({ status: "rejected", code: "limit_exceeded" });
	});
});

test("A15 partial: a small budget stops retrieval with a reason and real counters at or under the budget; no path is not no effect", async () => {
	await withHarness(async (h) => {
		const ref = await messageRef(h);
		for (let i = 0; i < 30; i++)
			await relate(
				h,
				ref,
				`x${String(i).padStart(2, "0")}`,
				"H",
				`T${i}`,
				"causes",
			);
		const q = open(h);
		const cut = ok(
			await q.query(ctx, { mode: "snapshot", budget: { candidates: 10 } }),
		);
		expect(cut.completeness).toBe("partial");
		expect(cut.reasons).toContain("CANDIDATE_BUDGET");
		expect(cut.retrieval.partial).toBe(true);
		expect(cut.retrieval.fetchedRows).toBeLessThanOrEqual(10);
		if (cut.result.mode !== "snapshot") throw new Error("mode");
		expect(cut.result.entries.length).toBeLessThan(30);

		const wide = ok(
			await q.query(ctx, {
				mode: "relevance",
				entityId: "H",
				budget: { expansions: 2 },
			}),
		);
		expect(wide.completeness).toBe("partial");
		expect(wide.retrieval.expandedRows).toBeLessThanOrEqual(2);
		expect(wide.reasons).toContain("EXPANSION_BUDGET");

		const small = ok(
			await q.query(ctx, {
				mode: "influence",
				entityId: "H",
				budget: { paths: 3 },
			}),
		);
		if (small.result.mode !== "influence") throw new Error("mode");
		expect(small.result.influence.paths.length).toBeLessThanOrEqual(3);
		expect(small.completeness).toBe("partial");
		expect(small.reasons).toContain("PATH_BUDGET");

		// Unknown start entity: an empty answer that says "no path found", never "no effect".
		const none = ok(
			await q.query(ctx, { mode: "influence", entityId: "nobody" }),
		);
		if (none.result.mode !== "influence") throw new Error("mode");
		expect(none.result.influence.paths).toEqual([]);
		expect(none.result.influence.noPathMeaning).toBe(
			"NO_PATH_FOUND_NOT_NO_EFFECT",
		);
	});
});

test("out of scope: not granted, foreign principal and unknown look the same; nothing about existence is said", async () => {
	await withHarness(async (h) => {
		await seedGraph(h);
		const q = open(h);
		const hidden = { status: "rejected", code: "not_available" } as const;
		// A scope the caller was not granted (it exists) and one that never existed.
		expect(
			await q.query(
				{ principal: SCOPE.principal, scopeKeys: ["other"] },
				{ mode: "snapshot", scopeKey: SCOPE.scopeKey },
			),
		).toEqual(hidden);
		expect(
			await q.query(ctx, { mode: "snapshot", scopeKey: "never-existed" }),
		).toEqual(hidden);
		expect(
			await q.query(
				{ principal: SCOPE.principal, scopeKeys: [] },
				{ mode: "snapshot" },
			),
		).toEqual(hidden);
		// Several granted scopes and none named: ambiguous, not a guess.
		expect(
			await q.query(
				{ principal: SCOPE.principal, scopeKeys: [SCOPE.scopeKey, "other"] },
				{ mode: "snapshot" },
			),
		).toEqual(hidden);
		expect(
			await q.query(
				{ principal: "", scopeKeys: [SCOPE.scopeKey] },
				BASE.snapshot,
			),
		).toEqual(hidden);
		// Another principal over the same scope key sees an empty ledger, exactly
		// what the owner gets for an entity that does not exist.
		const foreign = ok(
			await q.query(
				{ principal: "someone-else", scopeKeys: [SCOPE.scopeKey] },
				{ mode: "relevance", entityId: "A" },
			),
		);
		const absent = ok(
			await q.query(ctx, { mode: "relevance", entityId: "zzz" }),
		);
		if (
			foreign.result.mode !== "relevance" ||
			absent.result.mode !== "relevance"
		)
			throw new Error("mode");
		expect(foreign.result.relevance.entities.map((e) => e.entityId)).toEqual([
			"A",
		]);
		expect(foreign.result.relevance.relations).toEqual([]);
		expect(foreign.basis).toEqual([]);
		expect(foreign.reasons).toEqual(absent.reasons);
		expect(foreign.completeness).toBe(absent.completeness);
		// Goals: unknown, foreign and not adopted share one answer.
		const goals = createGoalsService(h.store);
		const src = { namespace: "conversation", kind: "message", id: "m1" };
		const theirs = await goals.adopt(
			{ principal: "someone-else", scopeKeys: [SCOPE.scopeKey] },
			{ scopeKey: SCOPE.scopeKey, desiredState: "他人の目標", source: src },
		);
		const proposed = await goals.propose(
			{ principal: SCOPE.principal, scopeKeys: [SCOPE.scopeKey] },
			{ scopeKey: SCOPE.scopeKey, desiredState: "提案のみ", source: src },
		);
		for (const goalId of ["no-such-goal", theirs.id, proposed.id])
			expect(await q.query(ctx, { mode: "gaps", goalId })).toEqual(hidden);
	});
});

test("A16 Goal: an adopted Goal of the scope is accepted; a withdrawn one blocks nothing; Gaps never grant execution", async () => {
	await withHarness(async (h) => {
		await seedGraph(h);
		const q = open(h);
		const goals = createGoalsService(h.store);
		const access = { principal: SCOPE.principal, scopeKeys: [SCOPE.scopeKey] };
		const src = { namespace: "conversation", kind: "message", id: "m1" };
		const goal = await goals.adopt(access, {
			scopeKey: SCOPE.scopeKey,
			desiredState: "応答遅延を下げる",
			source: src,
		});
		const withGoal = ok(await q.query(ctx, { mode: "gaps", goalId: goal.id }));
		if (withGoal.result.mode !== "gaps") throw new Error("mode");
		expect(withGoal.result.gaps.gaps.length).toBeGreaterThan(0);
		// A Gap is something to confirm, not something to run.
		expect(withGoal.executionPermission).toBe("none");
		expect(withGoal.referenceOnly).toBe(true);
		for (const gap of withGoal.result.gaps.gaps)
			expect(Object.keys(gap).sort()).toEqual(
				[
					"blocksGoal",
					"confirmWith",
					"confirmationCost",
					"deadlineAt",
					"edgeId",
					"gapKey",
					"kind",
					"subjectId",
				].sort(),
			);
		await goals.withdraw(access, goal.id, { expectedRevision: 1, source: src });
		expect(
			ok(await q.query(ctx, { mode: "gaps", goalId: goal.id })).status,
		).toBe("ok");
	});
});

test("World OFF is an explicit disabled answer; a closed startup gate is unavailable; neither reads or writes", async () => {
	await withHarness(
		async (h) => {
			const probe = taskPort({ delegated: true });
			const q = open(h, { gapTasks: probe.port });
			const before = dump(h);
			for (const request of Object.values(BASE))
				expect(await q.query(ctx, request)).toEqual({
					status: "disabled",
					code: "world_disabled",
				});
			expect(await q.query(ctx, { mode: "gaps", linkGaps: true })).toEqual({
				status: "disabled",
				code: "world_disabled",
			});
			expect(probe.calls).toHaveLength(0);
			expect(dump(h)).toEqual(before);
			// A malformed request is still rejected on its own shape.
			expect(await q.query(ctx, { mode: "nope" })).toEqual({
				status: "rejected",
				code: "unknown_mode",
			});
		},
		{},
		{ enabled: false },
	);
	const gate = createWorldHostGate("open");
	await withHarness(
		async (h) => {
			await seedGraph(h);
			const q = open(h);
			expect(ok(await q.query(ctx, BASE.snapshot!)).status).toBe("ok");
			gate.close("TEST");
			expect(await q.query(ctx, BASE.snapshot!)).toEqual({
				status: "blocked",
				code: "world_unavailable",
			});
			gate.open();
			expect(ok(await q.query(ctx, BASE.snapshot!)).status).toBe("ok");
		},
		{ gate },
	);
});

test("A47 Gap -> Task: no port means display only; no delegation means zero Tasks; the same Gap is one Task", async () => {
	await withHarness(async (h) => {
		await seedGraph(h);
		const request = { mode: "gaps", linkGaps: true };

		// 1. No Task port: Gaps shown, linkage not accepted, nothing recorded.
		const shown = ok(await open(h).query(ctx, request));
		expect(shown.taskLinkage).toEqual({ status: "not_accepted" });
		if (shown.result.mode !== "gaps") throw new Error("mode");
		const gaps = shown.result.gaps.gaps;
		expect(gaps.length).toBeGreaterThanOrEqual(3);
		expect(count(h, "world_host_gap_task")).toBe(0);

		// 2. The port refuses (no delegation / no budget): zero Tasks, zero rows.
		const denied = taskPort({ delegated: false });
		const refused = ok(
			await open(h, { gapTasks: denied.port }).query(ctx, request),
		);
		expect(refused.taskLinkage).toMatchObject({ status: "attempted" });
		if (refused.taskLinkage?.status !== "attempted") throw new Error("link");
		expect(refused.taskLinkage.links.map((l) => l.status)).toEqual(
			gaps.map(() => "denied"),
		);
		expect(refused.taskLinkage.links[0]).toMatchObject({
			status: "denied",
			reason: "no_delegation",
		});
		expect(denied.created).toHaveLength(0);
		expect(count(h, "world_host_gap_task")).toBe(0);
		expect(count(h, "host_probe")).toBe(0);

		// 3. A plain query (no linkGaps) never reaches the port, delegated or not.
		const quiet = taskPort({ delegated: true });
		const q = open(h, { gapTasks: quiet.port });
		ok(await q.query(ctx, { mode: "gaps" }));
		for (const mode of ["snapshot", "relevance", "influence"])
			ok(await q.query(ctx, BASE[mode]!));
		expect(quiet.calls).toHaveLength(0);

		// 4. Delegated: one Task per Gap, keyed by the stable key; asking again
		// finds the existing links and creates nothing.
		const first = ok(await q.query(ctx, request));
		if (first.taskLinkage?.status !== "attempted") throw new Error("link");
		expect(first.taskLinkage.links.map((l) => l.status)).toEqual(
			gaps.map(() => "created"),
		);
		expect(quiet.created).toEqual(gaps.map((g) => gapTaskKey(SCOPE, g.gapKey)));
		expect(new Set(quiet.created).size).toBe(gaps.length);
		expect(count(h, "world_host_gap_task")).toBe(gaps.length);
		const again = ok(await q.query(ctx, request));
		if (again.taskLinkage?.status !== "attempted") throw new Error("link");
		expect(again.taskLinkage.links.map((l) => l.status)).toEqual(
			gaps.map(() => "linked"),
		);
		expect(quiet.created).toHaveLength(gaps.length);
		expect(quiet.calls).toHaveLength(gaps.length);
		expect(count(h, "host_probe")).toBe(gaps.length);

		// 5. The Gap's request id is stable and well formed for a UUID-keyed Task entry.
		const key = gapTaskKey(SCOPE, gaps[0]!.gapKey);
		expect(gapTaskRequestId(key)).toBe(gapTaskRequestId(key));
		expect(z.uuid().safeParse(gapTaskRequestId(key)).success).toBe(true);
		expect(gapTaskKey(SCOPE, "a")).not.toBe(gapTaskKey(SCOPE, "b"));
		expect(gapTaskKey(SCOPE, "a")).not.toBe(
			gapTaskKey({ ...SCOPE, scopeKey: "other" }, "a"),
		);
		expect(gapTaskKey(SCOPE, "a")).toBe(gapTaskKey({ ...SCOPE }, "a"));
	});
});

test("A47 Gap -> Task: per-call link limit, all-or-nothing on a port failure, no linkage from a model tool", async () => {
	await withHarness(async (h) => {
		const ref = await messageRef(h);
		for (let i = 0; i < 7; i++)
			await relate(h, ref, `g${i}`, `P${i}`, `Q${i}`, "causes");
		const request = { mode: "gaps", linkGaps: true };

		const limited = taskPort({ delegated: true });
		const done = ok(
			await open(h, { gapTasks: limited.port }).query(ctx, request),
		);
		if (done.taskLinkage?.status !== "attempted") throw new Error("link");
		const statuses = done.taskLinkage.links.map((l) => l.status);
		expect(statuses.filter((s) => s === "created")).toHaveLength(
			WORLD_QUERY_LIMITS.gapLinks,
		);
		expect(statuses.filter((s) => s === "skipped")).toHaveLength(
			7 - WORLD_QUERY_LIMITS.gapLinks,
		);
		expect(limited.calls).toHaveLength(WORLD_QUERY_LIMITS.gapLinks);

		// The port fails on the 2nd call of a fresh run: nothing of that run stays.
		const reset = await h.store.write((db) => {
			db.exec("DELETE FROM world_host_gap_task; DELETE FROM host_probe;");
		});
		void reset;
		const failing = taskPort({ delegated: true, throwOnCall: 2 });
		await expect(
			open(h, { gapTasks: failing.port }).query(ctx, request),
		).rejects.toThrow("port_boom");
		expect(count(h, "world_host_gap_task")).toBe(0);
		expect(count(h, "host_probe")).toBe(0);

		// The model-callable tool has no linkage in its vocabulary.
		const spy = taskPort({ delegated: true });
		const tool = createWorldQueryTool({
			query: open(h, { gapTasks: spy.port }),
			context: () => ctx,
		});
		expect(await tool.run({ mode: "gaps", linkGaps: true })).toEqual({
			status: "rejected",
			code: "invalid_request",
		});
		expect(JSON.stringify(z.toJSONSchema(worldQueryToolSchema))).not.toContain(
			"linkGaps",
		);
		ok(await tool.run({ mode: "gaps" }));
		expect(spy.calls).toHaveLength(0);
	});
});

test("a query never expands permissions or changes anything: every mode leaves all tables as they were", async () => {
	await withHarness(async (h) => {
		await seedGraph(h);
		const spy = taskPort({ delegated: true });
		const q = open(h, { gapTasks: spy.port });
		const before = dump(h);
		for (const request of Object.values(BASE)) ok(await q.query(ctx, request));
		h.store.readSnapshot((db) =>
			ok(q.queryInTransaction(db, ctx, BASE.snapshot)),
		);
		// A claim's own words never become a command: a payload naming a tool or
		// a permission is returned as reference data, flagged as such.
		const result = ok(await q.query(ctx, BASE.snapshot!));
		expect(result.referenceOnly).toBe(true);
		expect(result.executionPermission).toBe("none");
		expect(dump(h)).toEqual(before);
		expect(spy.calls).toHaveLength(0);
	});
});

test("the model tool binds the scope from the host, not from the model", async () => {
	await withHarness(async (h) => {
		await seedGraph(h);
		let bound: WorldQueryContext = ctx;
		const tool = createWorldQueryTool({
			query: open(h),
			context: () => bound,
		});
		expect(tool.id).toBe("world.query");
		expect(tool.modes).toEqual(WORLD_QUERY_MODES);
		expect(ok(await tool.run({ mode: "relevance", entityId: "A" })).mode).toBe(
			"relevance",
		);
		// The model cannot name another principal or reach a scope the host did not bind.
		expect(
			await tool.run({ mode: "snapshot", principal: "someone-else" }),
		).toEqual({ status: "rejected", code: "invalid_request" });
		expect(await tool.run({ mode: "snapshot", scopeKey: "other" })).toEqual({
			status: "rejected",
			code: "not_available",
		});
		bound = { principal: SCOPE.principal, scopeKeys: [] };
		expect(await tool.run({ mode: "snapshot" })).toEqual({
			status: "rejected",
			code: "not_available",
		});
	});
});

test("HTTP: status mapping, size and JSON limits; not-found and not-allowed are one answer", async () => {
	await withHarness(async (h) => {
		await seedGraph(h);
		const app = new Hono();
		registerWorldQuery(app, open(h), () => ctx);
		const post = (body: string) =>
			app.request("/api/world/query", { method: "POST", body });
		const good = await post(
			JSON.stringify({ mode: "relevance", entityId: "A" }),
		);
		expect(good.status).toBe(200);
		expect(((await good.json()) as { status: string }).status).toBe("ok");
		const unknown = await post(JSON.stringify({ mode: "sql" }));
		expect(unknown.status).toBe(400);
		expect(await unknown.json()).toEqual({
			status: "rejected",
			code: "unknown_mode",
		});
		const outside = await post(
			JSON.stringify({ mode: "snapshot", scopeKey: "x" }),
		);
		expect(outside.status).toBe(404);
		expect(await outside.json()).toEqual({
			status: "rejected",
			code: "not_available",
		});
		expect((await post("{not json")).status).toBe(400);
		const big = await post(
			JSON.stringify({ mode: "snapshot", pad: "x".repeat(70_000) }),
		);
		expect(big.status).toBe(400);
		expect(await big.json()).toEqual({
			status: "rejected",
			code: "limit_exceeded",
		});
	});
	await withHarness(
		async (h) => {
			const app = new Hono();
			registerWorldQuery(app, open(h), () => ctx);
			const off = await app.request("/api/world/query", {
				method: "POST",
				body: JSON.stringify({ mode: "snapshot" }),
			});
			expect(off.status).toBe(409);
			expect(await off.json()).toEqual({
				status: "disabled",
				code: "world_disabled",
			});
		},
		{},
		{ enabled: false },
	);
});
