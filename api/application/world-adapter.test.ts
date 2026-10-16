import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCapabilities } from "../domains/capabilities";
import {
	createActionRequests,
	createAdapterRegistry,
} from "../domains/tool-runtime";
import { describeMemoryAdapter, MEMORY_ADAPTER_REF } from "./memory-adapter";
import { bundleHostOf, hostAdapterDescriptions } from "./toolchain-adapters";
import { worldHarness } from "./world-claims.fixture";
import {
	createWorldAdapter,
	describeWorldAdapter,
	WORLD_ADAPTER_REF,
	type WorldAdapterPorts,
} from "./world-adapter";

const worldBundle = JSON.parse(
	readFileSync(
		join(
			import.meta.dir,
			"../domains/capabilities/bundles/settings-world.bundle.json",
		),
		"utf8",
	),
);

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
	for (const h of open.splice(0)) await h.close();
});

async function setup(options: Parameters<typeof worldHarness>[0] = {}) {
	const h = await worldHarness(options);
	open.push(h);
	const ports: WorldAdapterPorts = {
		claims: h.world.claims,
		documents: h.world.documents,
		context: h.world.claimsContext,
	};
	const adapter = createWorldAdapter(() => ports);
	return { ...h, ports, adapter };
}
type Harness = Awaited<ReturnType<typeof setup>>;

function run(
	h: Harness,
	operationName: string,
	input: unknown,
	options: { origin?: "ui" | "conversation"; requestId?: string } = {},
) {
	const requestId = options.requestId ?? crypto.randomUUID();
	return h.store.write((db) =>
		h.adapter.invokeInTransaction(db, {
			operationName,
			input,
			requestId,
			issuedAt: new Date().toISOString(),
			origin:
				options.origin === "conversation"
					? {
							kind: "conversation",
							owner: {} as never,
							runId: "r",
							conversationId: "c",
							messageId: "m",
						}
					: { kind: "ui", scope: "scope", actionRequestId: requestId },
		}),
	);
}
const codeOf = async (promise: Promise<unknown>) => {
	try {
		await promise;
		return "no_error";
	} catch (error) {
		return (error as Error).message;
	}
};
const read = (h: Harness, query: string) =>
	h.store.read((db) => h.adapter.sourceInTransaction(db, query, undefined))!
		.data as Record<string, any>;
const claimOf = (h: Harness, id: string) =>
	(read(h, "query:world.claims@1").items as Array<Record<string, any>>).find(
		(row) => row.id === id,
	);

test("describe offers the World queries and no operation; the shipped bundle registers with no issue and has no action", async () => {
	const d = describeWorldAdapter();
	expect([...d.queries].sort()).toEqual([
		"query:world.claims-page@1",
		"query:world.claims@1",
		"query:world.documents-page@1",
		"query:world.forgets@1",
		"query:world.status@1",
		"query:world.status@2",
	]);
	expect([...d.operations.keys()]).toEqual([]);
	const h = await setup();
	const host = bundleHostOf([
		...hostAdapterDescriptions,
		{ ref: MEMORY_ADAPTER_REF, describe: describeMemoryAdapter },
		{ ref: WORLD_ADAPTER_REF, describe: describeWorldAdapter },
	]);
	const caps = createCapabilities(h.store, new Set(), {
		bundleHost: () => host,
	});
	const result = await h.store.write((db) =>
		caps.importBundleInTransaction(db, worldBundle, host, { dryRun: true }),
	);
	expect(result.issues).toEqual([]);
	const artifact = worldBundle.artifacts[0];
	expect(artifact.launcher).toMatchObject({
		label: "World",
		group: "管理と確認",
	});
	// View only (plan G3): no write action, no row action, no schema of a change.
	expect(artifact.actionBindings).toEqual([]);
	for (const collection of artifact.collections)
		expect(collection.rowActions).toBeUndefined();
	expect(
		worldBundle.schemas.map((schema: { id: string }) => schema.id),
	).toEqual(["world-claims-page", "world-documents-page"]);
	// The adapter refuses the removed operations whoever asks.
	for (const name of ["world.correct", "world.retract", "world.forget"])
		expect(
			await codeOf(
				run(h, name, { claimId: "claim-report", expectedRevision: 1 }),
			),
		).toBe("capability_unavailable");
	expect(
		artifact.sourceBindings.map((b: { query: string }) => b.query).sort(),
	).toEqual([
		"query:world.claims-page@1",
		"query:world.documents-page@1",
		"query:world.forgets@1",
		"query:world.status@2",
	]);
});

test("World OFF has no ports: the adapter is unavailable and shows nothing", async () => {
	const h = await setup();
	const off = createWorldAdapter(() => undefined);
	expect(off.availableInTransaction(h.store.read((db) => db))).toBe(false);
	expect(
		off.sourceInTransaction(
			h.store.read((db) => db),
			"query:world.status@1",
			undefined,
		),
	).toBeNull();
	expect(
		off.readInTransaction(
			h.store.read((db) => db),
			crypto.randomUUID(),
		),
	).toBeNull();
	expect(h.adapter.availableInTransaction(h.store.read((db) => db))).toBe(true);
});

test("status, claims and forgets are plain rows with the words the screen shows", async () => {
	const h = await setup();
	expect(read(h, "query:world.status@1").items[0]).toMatchObject({
		id: "world",
		mode: "on",
		enabled: true,
		usable: true,
		gateOpen: true,
		state: "オン",
		listComplete: true,
		stopped: 0,
		claimsNote: "すべて表示しています",
		forgetsNote: "—",
	});
	const claims = read(h, "query:world.claims@1");
	expect(claims.complete).toBe(true);
	expect(claims.items).toHaveLength(4);
	expect(claimOf(h, "claim-report")).toMatchObject({
		subject: "svc-1",
		claim: "available : はい",
		toneLabel: "採用済み",
		originLabel: "本人の報告",
		evidenceLabel: "本人の発言",
	});
	// The grounds the legacy detail drawer showed are columns now.
	const grounds = claimOf(h, "claim-report")!;
	expect(grounds.condition).toBe("条件は記述されていません（未確認）");
	expect(grounds.supports).toContain("本人の発言 — message m1");
	expect(grounds.sourceVersions).toContain("message m1");
	expect(grounds.sourceVersions).toContain("現在の版");
	expect(grounds.refutations).toBe("なし");
	expect(grounds.history).toContain("版1:");
	expect(claimOf(h, "claim-hyp")).toMatchObject({
		toneLabel: "仮説（採用しても未確認）",
		originLabel: "モデルの仮説",
	});
	expect(claimOf(h, "claim-cand")).toMatchObject({
		adoption: "candidate",
		toneLabel: "候補（未採用）",
	});
	expect(claimOf(h, "claim-measured")).toMatchObject({
		toneLabel: "実測（採用済み）",
		claim: "latency : 120 ms",
	});
	expect(read(h, "query:world.forgets@1").items).toEqual([]);
	expect(
		claims.items.every(
			(row: Record<string, unknown>) => !("correctable" in row),
		),
	).toBe(true);
	// The reason choices belonged to the changes; there is no such query any more.
	expect(
		h.store.read((db) =>
			h.adapter.sourceInTransaction(
				db,
				"query:world.reason-messages@1",
				undefined,
			),
		),
	).toBeNull();
	expect(
		h.store.read((db) =>
			h.adapter.sourceInTransaction(db, "query:world.unknown@1", undefined),
		),
	).toBeNull();
});

test("the World bundle runs through the action ledger as a view: sources read, no change is accepted", async () => {
	const h = await setup();
	const registry = createAdapterRegistry([h.adapter]);
	const host = bundleHostOf(registry);
	const caps = createCapabilities(h.store, new Set(), {
		bundleHost: () => host,
	});
	const imported = await h.store.write((db) =>
		caps.importBundleInTransaction(db, worldBundle, host),
	);
	expect(imported.issues).toEqual([]);
	const ledger = createActionRequests({
		store: h.store,
		capabilities: caps,
		registry,
		scope: "test-scope",
	});
	const revisionId = "artifact:settings.world@6";
	expect(ledger.artifacts().map((a) => a.artifactRevisionId)).toContain(
		revisionId,
	);
	const rows = ledger.source(revisionId, "world-claims");
	expect(
		ledger.source(revisionId, "world-documents", undefined, { pageIndex: 99 })
			.data,
	).toMatchObject({ total: 0, pageIndex: 0, items: [] });
	expect(
		(rows.data as { items: Array<{ id: string }> }).items
			.map((i) => i.id)
			.sort(),
	).toEqual(["claim-cand", "claim-hyp", "claim-measured", "claim-report"]);
	// The three changes the earlier revision offered are not actions of this one.
	for (const actionId of ["correct", "retract", "forget"]) {
		const now = Date.now();
		const sent = await ledger
			.submit({
				version: 1,
				eventId: crypto.randomUUID(),
				eventCreatedAt: new Date(now).toISOString(),
				eventExpiresAt: new Date(now + 60_000).toISOString(),
				artifactId: "tab-1",
				artifactRevisionId: revisionId,
				source: "world-claims",
				sourceRevision: rows.revision,
				actionId,
				scopeRef: ledger.scopeRef,
				input: { claimId: "claim-report", expectedRevision: 1 },
			})
			.then(
				(result) => result.request.status,
				(error: Error) => error.message,
			);
		expect(sent).not.toBe("accepted");
	}
	expect(claimOf(h, "claim-report")).toBeDefined();
});

test("World table revision upgrades the catalog without changing the prior view and imports idempotently", async () => {
	const h = await setup();
	const registry = createAdapterRegistry([h.adapter]);
	const host = bundleHostOf(registry);
	const caps = createCapabilities(h.store, new Set(), {
		bundleHost: () => host,
	});
	const previous = structuredClone(worldBundle);
	previous.artifacts[0].revision = 4;
	for (const child of previous.artifacts[0].variants[0].definition.children) {
		if (child.source === "world-claims") child.presentation = "catalog";
		if (child.source === "world-forgets") delete child.presentation;
		delete child.tableColumns;
		delete child.detailMode;
	}
	const load = (bundle: unknown) =>
		h.store.write((db) => caps.importBundleInTransaction(db, bundle, host));
	expect((await load(previous)).issues).toEqual([]);
	const ledger = createActionRequests({
		store: h.store,
		capabilities: caps,
		registry,
		scope: "test-scope",
	});
	const archived = () =>
		h.store.read((db) =>
			caps.documentInTransaction(db, "artifact:settings.world@4"),
		);
	const before = archived();
	expect(before).not.toBeNull();
	for (let i = 0; i < 2; i++) {
		expect((await load(worldBundle)).issues).toEqual([]);
		expect(archived()).toEqual(before);
		expect(
			ledger.artifacts().map((entry) => entry.artifactRevisionId),
		).toContain("artifact:settings.world@6");
	}
});

test("an unavailable or partial list says why in the status row instead of passing for empty", async () => {
	const h = await setup();
	const withList = (list: unknown, forgets?: unknown) =>
		createWorldAdapter(() => ({
			...h.ports,
			claims: {
				...h.ports.claims,
				list: () => list as never,
				...(forgets ? { forgets: () => forgets as never } : {}),
			},
		}));
	const status = (adapter: ReturnType<typeof createWorldAdapter>) =>
		h.store.read((db) =>
			adapter.sourceInTransaction(db, "query:world.status@1", undefined),
		)!.data as { items: Array<Record<string, any>> };
	const down = withList(
		{ status: "failed", code: "world_unavailable" },
		{ status: "failed", code: "world_disabled" },
	);
	const note = status(down).items[0]!;
	expect(note.claimsNote).toContain("主張の一覧を表示できません");
	expect(note.forgetsNote).toBe(
		"Worldがオフのため、忘却の状況を表示できません",
	);
	const claims = h.store.read((db) =>
		down.sourceInTransaction(db, "query:world.claims@1", undefined),
	)!.data as Record<string, any>;
	expect(claims).toMatchObject({
		items: [],
		unavailable: "world_unavailable",
	});
	expect(claims.unavailableText).toContain("表示できません");
	const partial = status(
		withList({
			status: "ok",
			value: { scopeKey: "s", complete: false, stopped: 3, items: [] },
		}),
	).items[0]!;
	expect(partial.claimsNote).toContain("一部が表示されていません");
	expect(partial.claimsNote).toContain("利用を止めている主張が3件");
});

test("the forgets list marks the forgets still moving, and the bundle re-reads it only while one is", async () => {
	const h = await setup();
	const forgets = worldBundle.artifacts[0].collections.find(
		(c: { source: string }) => c.source === "world-forgets",
	);
	expect(forgets.refreshWhile).toEqual({ key: "inProgress", in: [true] });
	// A forget now comes from the steward / the lifecycle, never from this screen.
	const ctx = h.world.claimsContext();
	const forgetId = `forget-${crypto.randomUUID()}`;
	const request = {
		forgetId,
		scope: { principal: ctx.principal, scopeKey: ctx.scopeKeys[0]! },
		reasonCode: "FORGET_REQUESTED" as const,
		roots: [{ kind: "assertion" as const, id: "claim-cand", revision: 1 }],
		origin: "request" as const,
	};
	await h.world.lifecycle.acceptForget(request);
	expect(read(h, "query:world.forgets@1").items[0]).toMatchObject({
		forgetId,
		display: "complete",
		inProgress: false,
	});
});

test("paged claims fetch grounds for the selected page beyond row 50; compact status avoids reading lists", async () => {
	const h = await setup();
	const ctx = h.world.claimsContext();
	const original = h.world.claims.list(ctx);
	if (original.status !== "ok") throw new Error("fixture_list_failed");
	const first = original.value.items[0]!;
	let detailReads = 0;
	let listReads = 0;
	const adapter = createWorldAdapter(() => ({
		...h.ports,
		claims: {
			...h.ports.claims,
			list: () => {
				listReads++;
				return {
					...original,
					value: {
						...original.value,
						items: Array.from({ length: 1000 }, (_, i) => ({
							...first,
							id: `claim-${String(i).padStart(4, "0")}`,
							target: { subjectId: `対象${String(i).padStart(4, "0")}` },
						})),
					},
				};
			},
			detail: () => {
				detailReads++;
				return h.ports.claims.detail(ctx, { claimId: first.id });
			},
		},
	}));
	const page = (query: string, params?: unknown) =>
		h.store.readSnapshot((db) =>
			adapter.sourceInTransaction(db, query, undefined, params),
		)!.data as {
			total: number;
			pageIndex: number;
			items: Array<{ id: string; supports: string; connection?: string }>;
		};
	expect(page("query:world.status@2").items[0]?.connection).toBe("online");
	expect(listReads).toBe(0);
	const result = page("query:world.claims-page@1", {
		pageIndex: 99,
		pageSize: 10,
		sort: "subject",
	});
	expect(result).toMatchObject({ total: 1000, pageIndex: 99 });
	expect(result.items[0]?.id).toBe("claim-0990");
	expect(result.items[0]?.supports).not.toBe("—");
	expect(detailReads).toBe(10);
	expect(page("query:world.claims-page@1", { q: "対象0999" })).toMatchObject({
		total: 1,
		pageIndex: 0,
		items: [{ id: "claim-0999" }],
	});
	expect(page("query:world.claims-page@1", { pageIndex: 9999 })).toMatchObject({
		pageIndex: 99,
	});
});
