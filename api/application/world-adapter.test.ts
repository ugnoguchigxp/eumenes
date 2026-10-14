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
	const resumed: Array<Promise<unknown>> = [];
	const failures: unknown[] = [];
	const ports: WorldAdapterPorts = {
		claims: h.world.claims,
		context: h.world.claimsContext,
		resumeForget: (id) => {
			const run = h.world.lifecycle.resumeForget(id);
			resumed.push(run.catch(() => undefined));
			return run;
		},
		reasonMessages: () => [
			{ id: "m2", text: "いいえ、音声サービスは10月からです。" },
			{ id: "m1", text: "音声サービスは9月から利用できる。" },
		],
		onForgetAdvanceFailed: (error) => failures.push(error),
	};
	const adapter = createWorldAdapter(() => ports);
	const settled = async () => {
		await Promise.all(resumed.splice(0));
	};
	return { ...h, ports, adapter, failures, settled };
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
const revisionOf = (h: Harness, id: string) =>
	claimOf(h, id)!.revision as number;
const claimOf = (h: Harness, id: string) =>
	(read(h, "query:world.claims@1").items as Array<Record<string, any>>).find(
		(row) => row.id === id,
	);

test("describe offers the World queries and three writes; the shipped bundle registers with no issue", async () => {
	const d = describeWorldAdapter();
	expect([...d.queries].sort()).toEqual([
		"query:world.claims@1",
		"query:world.forgets@1",
		"query:world.reason-messages@1",
		"query:world.status@1",
	]);
	expect([...d.operations.keys()].sort()).toEqual([
		"world.correct",
		"world.forget",
		"world.retract",
	]);
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
	for (const action of artifact.actionBindings)
		expect(d.operations.get(action.operationId)?.inputSchemaRef).toBe(
			action.inputSchemaRef,
		);
});

test("World OFF has no ports: the adapter is unavailable, shows nothing and changes nothing", async () => {
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
	const failing = h.store.write((db) =>
		off.invokeInTransaction(db, {
			operationName: "world.forget",
			input: { claimId: "claim-report", expectedRevision: 1 },
			requestId: crypto.randomUUID(),
			issuedAt: new Date().toISOString(),
			origin: { kind: "ui", scope: "s", actionRequestId: "a" },
		}),
	);
	expect(await codeOf(failing)).toBe("capability_unavailable");
	expect(h.adapter.availableInTransaction(h.store.read((db) => db))).toBe(true);
});

test("status, claims, forgets and the reason choices are plain rows with the words the screen shows", async () => {
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
		correctable: true,
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
	expect(read(h, "query:world.reason-messages@1").options).toEqual([
		{ value: "m2", label: "いいえ、音声サービスは10月からです。" },
		{ value: "m1", label: "音声サービスは9月から利用できる。" },
	]);
	expect(
		h.store.read((db) =>
			h.adapter.sourceInTransaction(db, "query:world.unknown@1", undefined),
		),
	).toBeNull();
});

test("a correction carries the revision seen and a statement of the person; a refusal changes nothing", async () => {
	const h = await setup();
	const seen = revisionOf(h, "claim-report");
	const input = {
		claimId: "claim-report",
		expectedRevision: seen,
		reasonMessageId: "m2",
		valueKind: "boolean",
		value: "false",
	};
	// Not an input of the registered shape, or a value that does not fit its kind.
	expect(await codeOf(run(h, "world.correct", { ...input, extra: 1 }))).toBe(
		"invalid_input",
	);
	expect(
		await codeOf(run(h, "world.correct", { ...input, value: "maybe" })),
	).toBe("invalid_input");
	expect(
		await codeOf(
			run(h, "world.correct", { ...input, valueKind: "number", value: "x" }),
		),
	).toBe("invalid_input");
	expect(
		await codeOf(run(h, "world.correct", input, { origin: "conversation" })),
	).toBe("capability_unavailable");
	expect(
		await codeOf(
			run(h, "world.correct", { ...input, reasonMessageId: "nope" }),
		),
	).toBe("reason_source_unavailable");
	expect(
		await codeOf(run(h, "world.correct", { ...input, expectedRevision: 9 })),
	).toBe("revision_conflict");
	expect(
		await codeOf(run(h, "world.correct", { ...input, claimId: "nothing" })),
	).toBe("not_found");
	expect(claimOf(h, "claim-report")).toMatchObject({
		revision: seen,
		claim: "available : はい",
	});

	const corrected = await run(h, "world.correct", input);
	expect(corrected.receipt).toMatchObject({
		kind: "claim-corrected",
		claimId: "claim-report",
		status: "applied",
	});
	expect(claimOf(h, "claim-report")).toMatchObject({
		claim: "available : いいえ",
		toneLabel: "採用済み",
	});
	expect(revisionOf(h, "claim-report")).toBeGreaterThan(seen);
	// The revision the person saw is stale now.
	expect(await codeOf(run(h, "world.correct", input))).toBe(
		"revision_conflict",
	);
	// A number states its unit.
	await run(h, "world.correct", {
		claimId: "claim-measured",
		expectedRevision: revisionOf(h, "claim-measured"),
		reasonMessageId: "m1",
		valueKind: "number",
		value: "95",
		unit: "ms",
	});
	expect(claimOf(h, "claim-measured")?.claim).toBe("latency : 95 ms");
});

test("a change in a transaction that fails afterwards leaves nothing behind", async () => {
	const h = await setup();
	const seen = revisionOf(h, "claim-report");
	const failing = h.store.write((db) => {
		h.ports.claims.retractInTransaction(db, h.ports.context(), {
			requestId: crypto.randomUUID(),
			expectedRevision: seen,
			target: { claimId: "claim-report" },
			reasonMessageId: "m2",
		});
		throw new Error("outer_failure");
	});
	expect(await codeOf(failing)).toBe("outer_failure");
	expect(revisionOf(h, "claim-report")).toBe(seen);
	const forgetting = h.store.write((db) => {
		h.ports.claims.forgetInTransaction(db, h.ports.context(), {
			requestId: crypto.randomUUID(),
			expectedRevision: seen,
			target: { claimId: "claim-report" },
		});
		throw new Error("outer_failure");
	});
	expect(await codeOf(forgetting)).toBe("outer_failure");
	expect(read(h, "query:world.forgets@1").items).toEqual([]);
});

test("a retraction needs the statement too and keeps the claim as history", async () => {
	const h = await setup();
	const input = {
		claimId: "claim-hyp",
		expectedRevision: revisionOf(h, "claim-hyp"),
		reasonMessageId: "m1",
	};
	expect(
		await codeOf(
			run(h, "world.retract", { ...input, reasonMessageId: "nope" }),
		),
	).toBe("reason_source_unavailable");
	const retracted = await run(h, "world.retract", input);
	expect(retracted.receipt).toMatchObject({
		kind: "claim-retracted",
		claimId: "claim-hyp",
		status: "applied",
	});
	expect(claimOf(h, "claim-hyp")).toBeUndefined();
	expect(await codeOf(run(h, "world.retract", input))).toBe("not_found");
});

test("a forget is accepted first and only the ledger says when it is complete", async () => {
	const h = await setup();
	const requestId = crypto.randomUUID();
	const accepted = await run(
		h,
		"world.forget",
		{
			claimId: "claim-measured",
			expectedRevision: revisionOf(h, "claim-measured"),
		},
		{ requestId },
	);
	expect(accepted.receipt).toMatchObject({
		kind: "claim-forget",
		status: "accepted",
		display: "pending",
		completed: false,
	});
	const forgetId = (accepted.receipt as { forgetId: string }).forgetId;
	expect(read(h, "query:world.forgets@1").items).toMatchObject([
		{
			forgetId,
			display: "pending",
			displayLabel: "処理中（完了ではありません）",
		},
	]);
	// The same request is the same forget; another one names a different claim.
	const again = await run(
		h,
		"world.forget",
		{
			claimId: "claim-measured",
			expectedRevision: revisionOf(h, "claim-measured"),
		},
		{ requestId },
	);
	expect((again.receipt as { forgetId: string }).forgetId).toBe(forgetId);
	// The receipt is read with how far the forget got, under the same identity.
	const before = h.store.read((db) =>
		h.adapter.readInTransaction(db, requestId),
	)!;
	expect(before.receiptRef.digest).toBe(accepted.receiptRef.digest);
	expect(before.receipt).toMatchObject({
		status: "accepted",
		completed: false,
	});

	h.adapter.afterCommit!();
	await h.settled();
	expect(h.failures).toEqual([]);
	const after = h.store.read((db) =>
		h.adapter.readInTransaction(db, requestId),
	)!;
	expect(after.receiptRef.digest).toBe(accepted.receiptRef.digest);
	const row = (
		read(h, "query:world.forgets@1").items as Array<Record<string, any>>
	)[0]!;
	expect(after.receipt).toMatchObject({
		status: "accepted",
		display: row.display,
		completed: row.display === "complete",
	});
	expect(row.display).toBe("complete");
	expect(claimOf(h, "claim-measured")).toBeUndefined();
});

test("a forget that stops while advancing stays accepted and pending, and is reported, not hidden", async () => {
	const h = await setup({ stallForget: true });
	const requestId = crypto.randomUUID();
	await run(
		h,
		"world.forget",
		{ claimId: "claim-cand", expectedRevision: revisionOf(h, "claim-cand") },
		{ requestId },
	);
	h.adapter.afterCommit!();
	await h.settled();
	expect(h.failures).toHaveLength(1);
	const row = (
		read(h, "query:world.forgets@1").items as Array<Record<string, any>>
	)[0]!;
	expect(row.display).not.toBe("complete");
	const receipt = h.store.read((db) =>
		h.adapter.readInTransaction(db, requestId),
	)!.receipt as Record<string, unknown>;
	expect(receipt).toMatchObject({ status: "accepted", completed: false });
	expect(receipt.display).toBe(row.display);
});

test("the World bundle runs through the action ledger", async () => {
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
	const revisionId = "artifact:settings.world@2";
	expect(ledger.artifacts().map((a) => a.artifactRevisionId)).toContain(
		revisionId,
	);
	const rows = ledger.source(revisionId, "world-claims");
	expect(
		(rows.data as { items: Array<{ id: string }> }).items
			.map((i) => i.id)
			.sort(),
	).toEqual(["claim-cand", "claim-hyp", "claim-measured", "claim-report"]);
	const send = (actionId: string, input: unknown) => {
		const now = Date.now();
		return ledger.submit({
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
			input,
		});
	};
	const stale = await send("retract", {
		claimId: "claim-hyp",
		expectedRevision: 40,
		reasonMessageId: "m1",
	});
	expect(stale.request).toMatchObject({
		status: "rejected",
		errorCode: "revision_conflict",
	});
	const forgot = await send("forget", {
		claimId: "claim-report",
		expectedRevision: revisionOf(h, "claim-report"),
	});
	expect(forgot.request.status).toBe("accepted");
	// What the screen is handed is "accepted", not "done".
	expect(forgot.request.result?.receipt).toMatchObject({
		status: "accepted",
		completed: false,
	});
	await h.settled();
	expect(
		(
			ledger.source(revisionId, "world-forgets").data as {
				items: Array<{ display: string }>;
			}
		).items,
	).toHaveLength(1);
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
	await run(h, "world.forget", {
		claimId: "claim-cand",
		expectedRevision: revisionOf(h, "claim-cand"),
	});
	expect(read(h, "query:world.forgets@1").items[0].inProgress).toBe(true);
	h.adapter.afterCommit!();
	await h.settled();
	expect(read(h, "query:world.forgets@1").items[0]).toMatchObject({
		display: "complete",
		inProgress: false,
	});
});
