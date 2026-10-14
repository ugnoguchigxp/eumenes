import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createCapabilities } from "../domains/capabilities";
import { worldQuery } from "../domains/capabilities/contracts/world-query";
import {
	WORLD_QUERY_MODES,
	worldQueryToolSchema,
} from "../domains/world/contracts/query";
import { describeMemoryAdapter, MEMORY_ADAPTER_REF } from "./memory-adapter";
import { toolchainTools } from "../domains/dialogue/service/conversation-tools";
import {
	bundleHostOf,
	hostAdapterDescriptions,
	offlineBundleHost,
} from "./toolchain-adapters";
import { worldHarness } from "./world-claims.fixture";
import {
	createWorldQueryAdapter,
	createWorldQueryPorts,
	describeWorldQueryAdapter,
	WORLD_QUERY_ADAPTER_REF,
	worldQueryAnswerContext,
} from "./world-query-adapter";

const bundle = JSON.parse(
	readFileSync(
		join(
			import.meta.dir,
			"../domains/capabilities/bundles/world-query.bundle.json",
		),
		"utf8",
	),
);

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
	for (const h of open.splice(0)) await h.close();
});

async function setup() {
	const h = await worldHarness();
	open.push(h);
	const ports = createWorldQueryPorts({
		store: h.store,
		world: h.world.service,
		context: h.world.claimsContext,
	});
	const adapter = createWorldQueryAdapter(() => ports);
	const origin = {
		kind: "conversation" as const,
		owner: { rootRunId: "run", taskId: "t", cancelEpoch: 0 },
		runId: "run",
		conversationId: "main",
		messageId: "m1",
	};
	const invoke = (
		input: unknown,
		options: { operationName?: string; origin?: unknown } = {},
	) =>
		h.store.write((db) =>
			adapter.invokeInTransaction(db, {
				operationName: options.operationName ?? "world.query",
				input,
				requestId: crypto.randomUUID(),
				issuedAt: new Date().toISOString(),
				origin: (options.origin ?? origin) as typeof origin,
			}),
		);
	return { ...h, ports, adapter, invoke };
}
const codeOf = async (promise: Promise<unknown>) => {
	try {
		await promise;
		return "no_error";
	} catch (error) {
		return (error as Error).message;
	}
};

const overlay = (overlayId: string) => ({
	overlayId,
	addEdges: [],
	removeEdgeIds: [],
});
const SAMPLES: Record<string, unknown> = {
	snapshot: { mode: "snapshot", entityIds: ["svc-1"], depth: 1 },
	relevance: { mode: "relevance", entityId: "svc-1" },
	influence: { mode: "influence", entityId: "svc-1", direction: "forward" },
	dependencies: { mode: "dependencies", entityId: "svc-1" },
	scenarios: {
		mode: "scenarios",
		entityId: "svc-1",
		overlays: [overlay("a"), overlay("b")],
	},
	gaps: { mode: "gaps", entityIds: ["svc-1"] },
};

test("describe offers one read operation; the model's schema is World's own tool schema; the bundle registers", async () => {
	const d = describeWorldQueryAdapter();
	expect([...d.operations]).toEqual([
		["world.query", { inputSchemaRef: "builtin:worldQuery", effect: "read" }],
	]);
	expect([...d.queries]).toEqual([]);
	// capabilities may not import the world domain, so its copy of the fields is held equal by this test:
	// every field of the flat object is one of the union's fields, with the same limits.
	const strip = (value: unknown): unknown =>
		Array.isArray(value)
			? value.map(strip)
			: value && typeof value === "object"
				? Object.fromEntries(
						Object.entries(value)
							.filter(([key]) => key !== "description")
							.map(([key, child]) => [key, strip(child)]),
					)
				: value;
	const flat = z.toJSONSchema(worldQuery) as {
		type: string;
		properties: Record<string, unknown>;
		anyOf?: unknown;
	};
	expect(flat.type).toBe("object");
	expect(flat.anyOf).toBeUndefined();
	const union = z.toJSONSchema(worldQueryToolSchema) as {
		oneOf?: Array<{ properties: Record<string, unknown> }>;
		anyOf?: Array<{ properties: Record<string, unknown> }>;
	};
	const branches = union.oneOf ?? union.anyOf ?? [];
	expect(branches).toHaveLength(WORLD_QUERY_MODES.length);
	for (const [field, schema] of Object.entries(flat.properties)) {
		if (field === "mode") continue;
		const owners = branches.filter((b) => field in b.properties);
		expect(owners.length).toBeGreaterThan(0);
		for (const branch of owners)
			expect(strip(schema)).toEqual(strip(branch.properties[field]));
	}
	for (const mode of WORLD_QUERY_MODES) {
		expect(worldQuery.safeParse(SAMPLES[mode]).success).toBe(true);
		expect(worldQueryToolSchema.safeParse(SAMPLES[mode]).success).toBe(true);
	}
	// Never linkGaps: not in the vocabulary of the model.
	const link = { mode: "gaps", linkGaps: true };
	expect(worldQuery.safeParse(link).success).toBe(false);
	expect(worldQueryToolSchema.safeParse(link).success).toBe(false);

	const h = await setup();
	const host = bundleHostOf([
		...hostAdapterDescriptions,
		{ ref: MEMORY_ADAPTER_REF, describe: describeMemoryAdapter },
		{ ref: WORLD_QUERY_ADAPTER_REF, describe: describeWorldQueryAdapter },
	]);
	const caps = createCapabilities(h.store, new Set(["world-query"]), {
		bundleHost: () => host,
	});
	// The toolchain presents the World screen's artifact: that bundle is registered first.
	const screen = JSON.parse(
		readFileSync(
			join(
				import.meta.dir,
				"../domains/capabilities/bundles/settings-world.bundle.json",
			),
			"utf8",
		),
	);
	const imported = await h.store.write((db) =>
		caps.importBundleInTransaction(db, screen, host),
	);
	expect(imported.issues).toEqual([]);
	const result = await h.store.write((db) =>
		caps.importBundleInTransaction(db, bundle, host, { dryRun: true }),
	);
	expect(result.issues).toEqual([]);
	const toolchain = bundle.definitions.find(
		(x: { kind: string }) => x.kind === "toolchain",
	);
	expect(toolchain.functionName).toBe("world_query");
	expect(bundle.bindings[0].tools).toHaveLength(1);
});

test("every mode answers over the bound Scope; the receipt names the query, the answer sees reference data with no permission", async () => {
	const h = await setup();
	for (const mode of WORLD_QUERY_MODES) {
		const saved = await h.invoke(SAMPLES[mode]);
		expect(saved.receipt).toMatchObject({
			version: 1,
			kind: "world_query",
			mode,
		});
		expect(saved.replay).toBe(false);
		expect(saved.answerContext).toMatchObject({
			version: 1,
			kind: "world_query",
			mode,
			referenceOnly: true,
			executionPermission: "none",
			scopeKey: "profile:owner",
		});
		// The ledger keeps no claim: only the query's name and digest.
		expect(JSON.stringify(saved.receipt)).not.toContain("音声サービスは");
	}
	const snapshot = await h.invoke(SAMPLES.snapshot!);
	const context = snapshot.answerContext as {
		result: { entries: unknown[] };
		basis: unknown[];
	};
	expect(context.result.entries.length).toBeGreaterThan(0);
	expect(JSON.stringify(context.result.entries)).toContain("claim-report");
	// No Task is ever linked by a query.
	expect(
		(
			h.store.read((db) =>
				db.query("SELECT COUNT(*) AS n FROM world_host_gap_task").get(),
			) as { n: number }
		).n,
	).toBe(0);
});

test("linkGaps, a wrong shape, a Scope that is not granted and a screen origin are refused", async () => {
	const h = await setup();
	expect(await codeOf(h.invoke({ mode: "gaps", linkGaps: true }))).toBe(
		"invalid_input",
	);
	expect(await codeOf(h.invoke({ mode: "weather" }))).toBe("invalid_input");
	expect(await codeOf(h.invoke({ mode: "snapshot", extra: 1 }))).toBe(
		"invalid_input",
	);
	// A Scope the host did not grant: the same answer as a missing one.
	expect(
		await codeOf(h.invoke({ mode: "snapshot", scopeKey: "profile:other" })),
	).toBe("not_available");
	expect(
		await codeOf(
			h.invoke(SAMPLES.snapshot!, {
				origin: { kind: "ui", scope: "s", actionRequestId: "a" },
			}),
		),
	).toBe("unsupported_origin");
	expect(
		await codeOf(
			h.invoke(SAMPLES.snapshot!, { operationName: "world.forget" }),
		),
	).toBe("unsupported_operation");
});

test("World not ON: the tool is unavailable and nothing is offered", async () => {
	const h = await setup();
	const off = createWorldQueryAdapter(() => undefined);
	h.store.readSnapshot((db) => {
		expect(off.availableInTransaction(db)).toBe(false);
		expect(off.snapshotInTransaction(db)).toEqual({ entities: [] });
		expect(off.readInTransaction(db, "wq1.e30")).toBeNull();
		expect(h.adapter.availableInTransaction(db)).toBe(true);
	});
	// The artifact listing asks on a plain read, outside a transaction.
	expect(h.store.read((db) => h.adapter.availableInTransaction(db))).toBe(true);
	expect(
		await codeOf(
			h.store.write((tx) =>
				off.invokeInTransaction(tx, {
					operationName: "world.query",
					input: SAMPLES.snapshot,
					requestId: "r",
					issuedAt: new Date().toISOString(),
					origin: {
						kind: "conversation",
						owner: { rootRunId: "run", taskId: "t", cancelEpoch: 0 },
						runId: "run",
						conversationId: "main",
						messageId: "m1",
					},
				}),
			),
		),
	).toBe("capability_unavailable");
});

test("the command sub-agent is shown the Scope's targets by id and name; a later read re-asks the same query", async () => {
	const h = await setup();
	expect(
		h.store.readSnapshot((db) => h.adapter.snapshotInTransaction(db)),
	).toEqual({ entities: [{ id: "svc-1", name: "音声サービス" }] });
	const saved = await h.invoke(SAMPLES.snapshot!);
	// The ledger holds the id and the digest; the read answers again with the same identity.
	const again = h.store.readSnapshot((tx) =>
		h.adapter.readInTransaction(tx, saved.receiptRef.operationId),
	)!;
	expect(again.receiptRef).toEqual(saved.receiptRef);
	expect(again.replay).toBe(true);
	expect(again.answerContext).toMatchObject({ mode: "snapshot" });
	// A made-up id is nothing.
	for (const id of ["nope", "wq1.", "wq1.@@@", `wq1.${btoa("{}")}`])
		expect(
			h.store.readSnapshot((tx) => h.adapter.readInTransaction(tx, id)),
		).toBeNull();
});

test("the projection the answer sees stays within the size the runtime accepts, cutting the basis first", () => {
	const claim = (i: number) => ({
		id: `c-${i}`,
		revision: 1,
		subjectId: "svc-1",
		predicate: "note",
		status: "active",
		freshness: "unknown",
		origin: "user_report",
		causalEligible: true,
		condition: { kind: "unspecified" },
		refutations: [],
		sources: [],
		value: "あ".repeat(200),
	});
	const make = (basis: number, resultBytes: number) =>
		({
			status: "ok",
			mode: "snapshot",
			scopeKey: "s",
			asOf: 1,
			completeness: "complete",
			reasons: [],
			result: {
				mode: "snapshot",
				entries: [],
				filler: "x".repeat(resultBytes),
			},
			basis: Array.from({ length: basis }, (_, i) => claim(i)),
			basisTruncated: false,
			retrieval: {
				partial: false,
				reasons: [],
				fetchedRows: 0,
				expandedRows: 0,
			},
			referenceOnly: true,
			executionPermission: "none",
		}) as never;
	const size = (value: unknown) =>
		new TextEncoder().encode(JSON.stringify(value)).length;
	const cut = worldQueryAnswerContext(make(200, 0));
	expect(size(cut)).toBeLessThanOrEqual(30_000);
	expect(cut.basisTruncated).toBe(true);
	expect(cut.basis.length).toBeGreaterThan(0);
	const omitted = worldQueryAnswerContext(make(0, 40_000));
	expect(size(omitted)).toBeLessThanOrEqual(30_000);
	expect(omitted).toMatchObject({
		result: null,
		completeness: "partial",
		executionPermission: "none",
	});
	expect(omitted.reasons).toContain("result_omitted_by_size");
	expect(worldQueryAnswerContext(make(2, 0)).basisTruncated).toBe(false);
});

test("routing: the offered world_query is for questions about impact, dependency, relevance, comparison and gaps; a statement or a request to remember/forget goes elsewhere", async () => {
	const h = await setup();
	const caps = createCapabilities(
		h.store,
		new Set(["steward", "world-query"]),
		{ bundleHost: offlineBundleHost },
	);
	await caps.seed();
	const cards = h.store.readSnapshot((db) =>
		caps.toolchainCandidatesInTransaction(db, {
			text: "x",
			available: () => true,
		}),
	);
	const card = cards.find((c) => c.id === "world.query")!;
	// The newest revision is the one offered; the first one stays as it was registered.
	expect(card.revisionId).toBe("toolchain:world.query@2");
	expect(card.functionName).toBe("world_query");
	expect(card.redirects).toEqual([
		{
			when: expect.stringContaining("忘れてほしい"),
			toolchainId: "steward.request",
			functionName: "memory_request",
		},
	]);
	const description = toolchainTools(cards).find(
		(t) => t.function.name === "world_query",
	)!.function.description;
	for (const phrase of [
		"何に影響する",
		"何に依存している",
		"関係が深いもの",
		"どちらが",
		"判断に足りない情報",
		"事実の申告や記憶の依頼には使わない",
		"目標の登録や片付けを頼む場合にはmemory_requestを使う",
	])
		expect(description).toContain(phrase);
	const latest = bundle.definitions.find(
		(d: { kind: string; revision: number }) =>
			d.kind === "toolchain" && d.revision === 2,
	);
	expect(latest.examples.length).toBeGreaterThanOrEqual(3);
	for (const example of latest.examples) {
		expect(example.length).toBeLessThanOrEqual(200);
		// Every example is a question or a request to look something up, never a statement of fact.
		expect(example).toMatch(/[？]|教えて/);
	}
	expect(latest.avoidWhen.join("\n")).toContain("事実や状況を述べているだけ");
});
