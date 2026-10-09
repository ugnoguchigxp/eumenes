import { expect, test } from "bun:test";
import { CONTRACT_VERSIONS, type SourceRef } from "eumenes-memory";
import {
	applyForget,
	planForget,
	registerExternalDependents,
} from "eumenes-memory/sqlite";
import {
	MAX_DEPENDS_ON,
	MemoryRegistrationRejected,
	WORLD_PROVIDER_REF,
	externalIdOf,
	planDependents,
	type SourceAdapter,
	type VersionInputs,
} from "..";
import {
	ACCESS,
	NOW,
	SCOPE,
	addMessage,
	adoptPlan,
	claim,
	count,
	currentRef,
	dump,
	entityOp,
	keyOf,
	probe,
	registerClaim,
	request,
	withHarness,
	worldEdges,
} from "./fixture";

const memoryAccess = (db: Parameters<typeof probe>[0]) => ({
	principal: SCOPE.principal,
	scopeKeys: [SCOPE.scopeKey],
	purpose: "world.test",
	policyRevision: String(
		(
			db
				.query("SELECT revision FROM memory_host_settings WHERE id = 1")
				.get() as {
				revision: number;
			}
		).revision,
	),
});

test("a registered assertion records one opaque Memory dependent per version", async () => {
	await withHarness(async (h) => {
		await addMessage(h, "m1", "音声サービスは9月から利用できる。");
		expect((await h.world.apply(entityOp())).status).toBe("applied");
		const result = await h.world.apply(
			registerClaim("c-1", claim("claim-1", [currentRef(h, "m1")])),
		);
		expect(result).toMatchObject({
			status: "applied",
			memory: { dependents: 1, registered: 1, unchanged: 0 },
		});
		const edges = worldEdges(h);
		expect(edges).toHaveLength(1);
		const edge = edges[0]!;
		expect(edge.dependency_type).toBe("source");
		expect(edge.dependency_id).toBe(keyOf("m1"));
		// providerRef is fixed; the externalId is opaque (no ids, no content).
		expect(edge.dependent_id.startsWith(`${WORLD_PROVIDER_REF}:`)).toBe(true);
		expect(edge.dependent_id).toBe(
			`${WORLD_PROVIDER_REF}:${externalIdOf("a", SCOPE.principal, SCOPE.scopeKey, ["claim-1", 1], 0)}`,
		);
		expect(edge.dependent_id).not.toContain("claim-1");
		expect(edge.dependent_id.length).toBeLessThan(256);
	});
});

test("a replay with the same operationKey is a no_op and registers nothing again", async () => {
	await withHarness(async (h) => {
		await addMessage(h, "m1", "text");
		await h.world.apply(entityOp());
		const op = registerClaim("c-1", claim("claim-1", [currentRef(h, "m1")]));
		expect((await h.world.apply(op)).status).toBe("applied");
		const before = dump(h);
		const again = await h.world.apply(op);
		expect(again.status).toBe("no_op");
		expect("memory" in again).toBe(false);
		expect(dump(h)).toEqual(before);
		// The same key with different content is a conflict, not a second write.
		const other = await h.world.apply(
			registerClaim("c-1", claim("claim-2", [currentRef(h, "m1")])),
		);
		expect(other).toMatchObject({ status: "rejected", stage: "world" });
		expect(dump(h)).toEqual(before);
	});
});

test("new versions get their own dependents and never overwrite an older version's", async () => {
	await withHarness(async (h) => {
		await addMessage(h, "m1", "first");
		await addMessage(h, "m2", "second");
		await h.world.apply(entityOp());
		await h.world.apply(
			registerClaim("c-1", claim("claim-1", [currentRef(h, "m1")])),
		);
		const first = worldEdges(h);
		expect(first.map((e) => e.dependency_id)).toEqual([keyOf("m1")]);
		// Supersede: revision 2 stands on m2 only.
		const adopt = adoptPlan("claim-1", 1);
		await h.world.apply(
			request("ad-1", { kind: "assertion.transition", plan: adopt }),
		);
		const { planAssertionTransition } = await import("eumenes-world-model");
		const replacement = claim("claim-1", [currentRef(h, "m2")], {
			revision: 3,
			supersedes: [{ id: "claim-1", revision: 2 }],
		});
		const plan = planAssertionTransition({
			contractVersion: 1,
			scope: SCOPE,
			current: {
				id: "claim-1",
				revision: 2,
				scope: SCOPE,
				lifecycle: "active",
				origin: "user_report",
			},
			expectedRevision: 2,
			request: { action: "supersede", replacementRevision: 3 },
			registeredAdoptionRules: [],
		} as never);
		if (!plan.ok || plan.value.status !== "planned")
			throw new Error(`plan failed ${JSON.stringify(plan)}`);
		const result = await h.world.apply(
			request("sup-1", {
				kind: "assertion.transition",
				plan: plan.value.plan,
				replacement,
			}),
		);
		expect(result).toMatchObject({ status: "applied" });
		const all = worldEdges(h);
		// Both versions' dependents exist; revision 1 still depends on m1.
		expect(all.map((e) => e.dependency_id).sort()).toEqual(
			[keyOf("m1"), keyOf("m2")].sort(),
		);
		expect(new Set(all.map((e) => e.dependent_id)).size).toBe(2);
		expect(all.some((e) => e.dependent_id === first[0]!.dependent_id)).toBe(
			true,
		);
	});
});

const synthetic = (n: number): SourceRef[] =>
	Array.from({ length: n }, (_, i) => ({
		namespace: "conversation",
		kind: "message",
		id: `msg-${String(i).padStart(3, "0")}`,
		representation: "text",
		revision: "r",
		digest: "d",
	}));

test("planDependents splits above 32 inputs, in a stable order, without truncating", () => {
	const version = (refs: SourceRef[]): VersionInputs => ({
		tag: "a",
		key: ["claim-x", 1],
		refs,
	});
	const planned = planDependents([version(synthetic(70))], SCOPE);
	if ("status" in planned) throw new Error("unexpected refusal");
	expect(planned.dependents.map((d) => d.dependsOn.length)).toEqual([
		32, 32, 6,
	]);
	expect(
		planned.dependents.every((d) => d.dependsOn.length <= MAX_DEPENDS_ON),
	).toBe(true);
	const ids = planned.dependents.map((d) => d.externalId);
	expect(new Set(ids).size).toBe(3);
	expect(ids.every((id) => id.length <= 256)).toBe(true);
	const covered = planned.dependents.flatMap((d) =>
		d.dependsOn.map((x) => x.id),
	);
	expect(new Set(covered).size).toBe(70);
	// Reordering the inputs gives the identical plan (replay safety).
	const reversed = planDependents([version(synthetic(70).reverse())], SCOPE);
	expect(reversed).toEqual(planned);
	// 32 is one dependent, 33 is two.
	for (const [n, parts] of [
		[32, 1],
		[33, 2],
	] as const) {
		const p = planDependents([version(synthetic(n))], SCOPE);
		if ("status" in p) throw new Error("unexpected refusal");
		expect(p.dependents).toHaveLength(parts);
	}
	// Above the host cap: refused whole, never cut.
	expect(planDependents([version(synthetic(300))], SCOPE)).toEqual({
		status: "rejected",
		reasonCode: "DEPENDENCY_LIMIT",
	});
	expect(
		planDependents([version(synthetic(10))], SCOPE, { maxInputs: 5 }),
	).toMatchObject({ reasonCode: "DEPENDENCY_LIMIT" });
	// A different revision, scope or tag is a different opaque id.
	const other = planDependents(
		[{ ...version(synthetic(3)), key: ["claim-x", 2] }],
		SCOPE,
	);
	if ("status" in other) throw new Error("unexpected refusal");
	expect(other.dependents[0]!.externalId).not.toBe(ids[0]);
});

test("32 manifest inputs plus a distinct cited source: two Memory dependents, none cut", async () => {
	await withHarness(async (h) => {
		const sources: SourceRef[] = [];
		for (let i = 0; i < 33; i += 1) {
			const id = `m${String(i).padStart(2, "0")}`;
			await addMessage(h, id, `text ${i}`);
			sources.push(currentRef(h, id));
		}
		await h.world.apply(entityOp());
		// World itself caps the manifest at 32; the cited 33rd source also needs a dependent.
		const cited = sources[32]!;
		const result = await h.world.apply(
			registerClaim(
				"c-1",
				claim("claim-1", sources.slice(0, 32), {
					evidence: [
						{
							evidenceId: "ev-33",
							kind: "user_statement",
							stance: "supports",
							source: cited,
							rootEvidenceId: "root-claim-1",
						},
					],
				}),
			),
		);
		expect(result).toMatchObject({ status: "applied" });
		expect(
			(result as { memory: { dependents: number } }).memory.dependents,
		).toBe(2);
		const edges = worldEdges(h);
		expect(edges).toHaveLength(33);
		expect(new Set(edges.map((e) => e.dependent_id)).size).toBe(2);
		expect(edges.some((e) => e.dependency_id === keyOf("m32"))).toBe(true);
		// Replaying changes nothing in Memory.
		const again = await h.world.apply(
			registerClaim(
				"c-1",
				claim("claim-1", sources.slice(0, 32), {
					evidence: [
						{
							evidenceId: "ev-33",
							kind: "user_statement",
							stance: "supports",
							source: cited,
							rootEvidenceId: "root-claim-1",
						},
					],
				}),
			),
		);
		expect(again.status).toBe("no_op");
		expect(worldEdges(h)).toHaveLength(33);
	});
});

test("out-of-scope, unknown and retracted inputs are refused before anything is written", async () => {
	await withHarness(async (h) => {
		await addMessage(h, "m1", "mine");
		await addMessage(h, "m2", "to be retracted");
		await h.world.apply(entityOp());
		const good = currentRef(h, "m1");
		const retracted = currentRef(h, "m2");
		await h.conversation.retract({ messageId: "m2" });
		const before = dump(h);
		const unknown = { ...good, id: "nope" };
		for (const bad of [unknown, retracted]) {
			const result = await h.world.apply(
				registerClaim("c-bad", claim("claim-bad", [good, bad])),
			);
			expect(result).toEqual({
				status: "rejected",
				reasonCode: "SOURCE_NOT_AVAILABLE",
				stage: "host",
			});
		}
		// A source in a scope the caller may not use looks exactly like a missing one.
		const foreign = await h.world.apply({
			...registerClaim("c-f", claim("claim-f", [good])),
			access: { ...ACCESS, scopeKeys: ["other-scope"] },
		});
		expect(foreign.status).not.toBe("applied");
		// No adapter for the namespace: held, not guessed.
		const noAdapter = await h.world.apply(
			registerClaim(
				"c-n",
				claim("claim-n", [{ ...good, namespace: "elsewhere" }]),
			),
		);
		expect(noAdapter).toEqual({
			status: "blocked",
			reasonCode: "SOURCE_ADAPTER_MISSING",
			stage: "host",
		});
		// A ref without representation is never guessed.
		const { representation: _r, ...bare } = good;
		const noRep = await h.world.apply(
			registerClaim("c-r", claim("claim-r", [bare as SourceRef])),
		);
		expect(noRep).toMatchObject({
			reasonCode: "SOURCE_REPRESENTATION_REQUIRED",
		});
		expect(dump(h)).toEqual(before);
		expect(worldEdges(h)).toHaveLength(0);
	});
});

test("A25: World accepted, Memory refuses (id in use) -> World, Memory and host rows all roll back", async () => {
	await withHarness(async (h) => {
		await addMessage(h, "m1", "text");
		await h.world.apply(entityOp());
		// Another scope already owns the externalId this version would use.
		const externalId = externalIdOf(
			"a",
			SCOPE.principal,
			SCOPE.scopeKey,
			["claim-1", 1],
			0,
		);
		await h.store.write((db) => {
			const taken = registerExternalDependents(db, {
				contractVersion: CONTRACT_VERSIONS.external,
				access: {
					...memoryAccess(db),
					scopeKeys: ["someone-else"],
				},
				scopeKey: "someone-else",
				clock: { atMs: NOW },
				dependents: [
					{
						providerRef: WORLD_PROVIDER_REF,
						externalId,
						dependsOn: [{ type: "source", id: keyOf("other") }],
					},
				],
			});
			expect(taken.status).toBe("registered");
		});
		const before = dump(h);
		const op = registerClaim("c-1", claim("claim-1", [currentRef(h, "m1")]));
		// Inside a host transaction with its own rows: the throw rolls everything back.
		await expect(
			h.store.write((db) => {
				probe(db);
				return h.world.applyInWriter(db, op);
			}),
		).rejects.toBeInstanceOf(MemoryRegistrationRejected);
		expect(dump(h)).toEqual(before);
		expect(count(h, "host_probe")).toBe(0);
		expect(count(h, "host_queue")).toBe(0);
		// The service surfaces a typed result and rolls back the same way.
		const typed = await h.world.apply(op);
		expect(typed).toEqual({
			status: "rejected",
			reasonCode: "MEMORY_EXTERNAL_ID_IN_USE",
			stage: "memory",
		});
		expect(dump(h)).toEqual(before);
		// World alone would have accepted it: the same op works once the id is free.
		expect(count(h, "world_assertion")).toBe(0);
	});
});

test("TOMBSTONED: a source Memory has forgotten cannot get a new dependent; the whole operation rolls back", async () => {
	await withHarness(async (h) => {
		await addMessage(h, "m1", "text");
		await h.world.apply(entityOp());
		await h.store.write((db) => {
			const access = memoryAccess(db);
			const planned = planForget(db, {
				contractVersion: CONTRACT_VERSIONS.lifecycle,
				access,
				target: {
					type: "host_source",
					sourceKey: keyOf("m1"),
					scopeKey: SCOPE.scopeKey,
				},
				clock: { atMs: NOW },
			});
			if (planned.status !== "planned") throw new Error("plan failed");
			applyForget(db, {
				contractVersion: CONTRACT_VERSIONS.lifecycle,
				entry: planned.plan.entry,
				clock: { atMs: NOW },
			});
		});
		const before = dump(h);
		const result = await h.world.apply(
			registerClaim("c-1", claim("claim-1", [currentRef(h, "m1")])),
		);
		expect(result).toEqual({
			status: "rejected",
			reasonCode: "MEMORY_TOMBSTONED",
			stage: "memory",
		});
		expect(dump(h)).toEqual(before);
		expect(worldEdges(h)).toHaveLength(0);
		// The host's own record of registered dependents rolled back with them.
		expect(count(h, "world_host_dependent")).toBe(0);
	});
});

const stateAdapter = (principal: string, scopeKey: string): SourceAdapter => ({
	namespace: "memory",
	resolveCurrent: (_db, _access, key) => ({
		status: "available",
		source: key,
		revision: "sha256:aa",
		digest: "aa",
		principal,
		scopeKey,
		speaker: "user",
		confirmed: true,
		ordinal: 1,
	}),
	readAuthorizedContent: () => {
		throw new Error("unused");
	},
	listChanges: () => {
		throw new Error("unused");
	},
});

test("a Memory State item input is scope-checked by Memory: a missing item rolls everything back", async () => {
	const { createConversationSourceAdapter } = await import("..");
	await withHarness(
		async (h) => {
			await addMessage(h, "m1", "text");
			await h.world.apply(entityOp());
			const before = dump(h);
			const item: SourceRef = {
				namespace: "memory",
				kind: "state_item",
				id: "state:".concat("0".repeat(64)),
				revision: "sha256:aa",
				digest: "aa",
			};
			const result = await h.world.apply(
				registerClaim("c-1", claim("claim-1", [currentRef(h, "m1"), item])),
			);
			expect(result).toEqual({
				status: "rejected",
				reasonCode: "MEMORY_DEPENDENCY_MISSING",
				stage: "memory",
			});
			expect(dump(h)).toEqual(before);
			void createConversationSourceAdapter;
		},
		{
			sources: [stateAdapter(SCOPE.principal, SCOPE.scopeKey)],
		},
	);
});
