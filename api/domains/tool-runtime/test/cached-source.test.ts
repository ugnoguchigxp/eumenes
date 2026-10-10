import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createCapabilities,
	migration as capMigration,
	type Owner,
} from "../../capabilities";
import { createQueue, migration as queueMigration } from "../../queue";
import {
	createToolRuntime,
	migration,
	routeGrantMigration,
	supersedeMigration,
	readMetadataMigration,
	type CachedSourceAuthorizationPort,
	type ToolAdapter,
} from "..";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const c of cleanup.splice(0)) c();
});
const URL_A = "https://weather.example.com/kamakura";
const owner: Owner = { rootRunId: "root", taskId: "child", cancelEpoch: 0 };

async function setup() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-cached-"));
	const store = openStore(join(dir, "db"), [
		capMigration,
		queueMigration,
		migration,
		routeGrantMigration,
		supersedeMigration,
		readMetadataMigration,
	]);
	const caps = createCapabilities(store),
		queue = createQueue(store);
	const started: Array<Record<string, unknown>> = [];
	let revision = "r1";
	const adapter: ToolAdapter = {
		operationFingerprintInTransaction: () => revision,
		prepareSourcesInTransaction: (_db, _inv, result) => result.readings,
		validateEvidenceInTransaction: () => true,
		startInTransaction: (_db, r) => {
			started.push(r as unknown as Record<string, unknown>);
			return {
				operationId: `op${started.length}`,
				jobId: `job${started.length}`,
			};
		},
		get: () => null,
		cancelInTransaction: () => [],
	};
	// Fake route ledger: token -> allowed urls; 'revoked' simulates clear/disable/new generation.
	const ledger = new Map<string, { urls: Set<string>; owner: string }>();
	const port: CachedSourceAuthorizationPort = {
		validateInTransaction: (_db, i) => {
			const g = ledger.get(i.bindingToken);
			if (!g) return { status: "rejected", code: "revoked" };
			if (g.owner !== i.owner.taskId)
				return { status: "rejected", code: "owner_mismatch" };
			if (!g.urls.has(i.exactUrl))
				return { status: "rejected", code: "url_mismatch" };
			return { status: "allowed" };
		},
	};
	const tools = createToolRuntime(store, caps, queue, adapter, Date.now, port);
	await caps.seed();
	const prepared = await store.write((db) => {
		return caps.prepareActiveByIdInTransaction(
			db,
			owner,
			"package:web.research@9",
			{ question: "天気" },
		);
	});
	cleanup.push(() => {
		tools.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return {
		store,
		tools,
		prepared,
		ledger,
		started,
		caps,
		setRevision: (r: string) => {
			revision = r;
		},
	};
}
const deadline = () => Date.now() + 100000;
const invoke = (
	t: Awaited<ReturnType<typeof setup>>,
	ref: string,
	args: unknown,
	step: string,
	as: Owner = owner,
) =>
	t.store.write((db) =>
		t.tools.invokeInTransaction(db, as, ref, args, step, deadline(), "p", []),
	);

test("R01 cached grant is per-owner, exact-URL, exact-args and re-checked against the port on every use", async () => {
	const t = await setup();
	t.ledger.set("tok", { urls: new Set([URL_A]), owner: "child" });
	const grant = (o: Owner = owner, token = "tok") =>
		t.store.write((db) =>
			t.tools.issueCachedGrantInTransaction(db, {
				owner: o,
				prepared: t.prepared,
				bindingToken: token,
				toolId: "web.read",
				arguments: { url: URL_A },
				exactUrl: URL_A,
				deadline: deadline(),
				attemptTimeoutMs: 5000,
			}),
		);
	const a = await grant();
	const again = await grant();
	expect(a.executionRef).not.toBe(again.executionRef);
	// other owner / unknown binding / wrong url at issue are rejected
	await expect(grant({ ...owner, taskId: "other" })).rejects.toThrow(
		"cached_source_rejected",
	);
	await expect(grant(owner, "nope")).rejects.toThrow("cached_source_rejected");
	await expect(
		t.store.write((db) =>
			t.tools.issueCachedGrantInTransaction(db, {
				owner,
				prepared: t.prepared,
				bindingToken: "tok",
				toolId: "web.read",
				arguments: { url: "https://other.example.com/" },
				exactUrl: URL_A,
				deadline: deadline(),
			}),
		),
	).rejects.toThrow("tool_url_out_of_scope");
	// foreign owner cannot use the reference; other URL is out of scope
	await expect(
		invoke(t, a.executionRef, { url: URL_A }, "s0", { ...owner, taskId: "x" }),
	).rejects.toThrow("tool_ref_invalid");
	await expect(
		invoke(t, a.executionRef, { url: "https://other.example.com/" }, "s1"),
	).rejects.toThrow("tool_url_out_of_scope");
	const inv = await invoke(t, a.executionRef, { url: URL_A }, "s2");
	expect(inv.state).toBe("pending");
	expect(t.started.at(-1)).toMatchObject({
		grantedUrl: URL_A,
		attemptTimeoutMs: 5000,
	});
	// stop/clear/new generation: the port revokes, the very next use fails
	t.ledger.delete("tok");
	await expect(
		invoke(t, again.executionRef, { url: URL_A }, "s3"),
	).rejects.toThrow("cached_source_rejected");
	// memory release after commit
	t.ledger.set("tok2", { urls: new Set([URL_A]), owner: "child" });
	const c = await grant(owner, "tok2");
	expect(t.tools.releaseBinding("tok2")).toBe(1);
	await expect(invoke(t, c.executionRef, { url: URL_A }, "s4")).rejects.toThrow(
		"tool_ref_invalid",
	);
});

test("R01 candidate import yields an owner-scoped observation, never a real lookup, and counts as one lookup allowance", async () => {
	const t = await setup();
	t.ledger.set("tok", {
		urls: new Set([URL_A, "https://b.example.com/"]),
		owner: "child",
	});
	const lookupId = t.prepared.dependencies.find(
		(d) => d.id === "web.lookup",
	)!.revisionId;
	const input = (over: Record<string, unknown> = {}) => ({
		owner,
		prepared: t.prepared,
		bindingToken: "tok",
		stepId: "import-1",
		deadline: deadline(),
		query: "天気予報 鎌倉",
		searchedAt: new Date(Date.now() - 3600_000).toISOString(),
		provenanceDigest: "d".repeat(64),
		hits: [
			{ url: URL_A, title: "Kamakura", snippet: "sunny" },
			{ url: "https://b.example.com/", title: "B", snippet: "b" },
		],
		...over,
	});
	const imp = (i: ReturnType<typeof input>) =>
		t.store.write((db) => t.tools.importSearchCandidatesInTransaction(db, i));
	// a URL the ledger does not vouch for aborts the whole import
	await expect(
		imp(
			input({
				hits: [{ url: "https://evil.example.com/", title: "x", snippet: "x" }],
			}),
		),
	).rejects.toThrow("cached_source_rejected");
	await expect(imp(input({ hits: [] }))).rejects.toThrow(
		"invalid_candidate_import",
	);
	await expect(imp(input({ bindingToken: "revoked" }))).rejects.toThrow(
		"cached_source_rejected",
	);
	const done = await imp(input());
	expect(done.state).toBe("succeeded");
	expect(done.origin).toBe("candidate-cache");
	expect(t.started.length).toBe(0); // no HTTP / queue job
	const obs = await t.store.write((db) =>
		t.tools.observationsInTransaction(db, "child"),
	);
	expect(obs).toHaveLength(1);
	expect(
		(obs[0] as { sources: { url: string; basis: string }[] }).sources.map(
			(s) => s.url,
		),
	).toEqual([URL_A, "https://b.example.com/"]);
	expect(
		await t.store.write((db) =>
			t.tools.countInTransaction(db, "child", lookupId),
		),
	).toBe(1);
	expect(
		await t.store.write((db) =>
			t.tools.countRealInTransaction(db, "child", lookupId),
		),
	).toBe(0);
	// idempotent per step; another owner cannot take over the step
	const same = await imp(input());
	expect(same.id).toBe(done.id);
	t.ledger.set("tok-o", { urls: new Set([URL_A]), owner: "other" });
	await expect(
		imp(input({ owner: { ...owner, taskId: "other" }, bindingToken: "tok-o" })),
	).rejects.toThrow("idempotency_conflict");
});

test("R01 without a configured port, cached grants and imports are unavailable (no silent success)", async () => {
	const t = await setup();
	const bare = createToolRuntime(t.store, t.caps, createQueue(t.store), {
		startInTransaction: () => ({ operationId: "o", jobId: "j" }),
		get: () => null,
		cancelInTransaction: () => [],
	});
	await expect(
		t.store.write((db) =>
			bare.issueCachedGrantInTransaction(db, {
				owner,
				prepared: t.prepared,
				bindingToken: "tok",
				toolId: "web.read",
				arguments: { url: URL_A },
				exactUrl: URL_A,
				deadline: deadline(),
			}),
		),
	).rejects.toThrow("cached_source_unavailable");
});

test("superseded invocations leave observations but stay in the budget and the invocation list", async () => {
	const t = await setup();
	t.ledger.set("tok", { urls: new Set([URL_A]), owner: "child" });
	const lookupId = t.prepared.dependencies.find(
		(d) => d.id === "web.lookup",
	)!.revisionId;
	await t.store.write((db) =>
		t.tools.importSearchCandidatesInTransaction(db, {
			owner,
			prepared: t.prepared,
			bindingToken: "tok",
			stepId: "imp",
			deadline: deadline(),
			query: "q",
			searchedAt: new Date().toISOString(),
			provenanceDigest: "d".repeat(64),
			hits: [{ url: URL_A, title: "A", snippet: "a" }],
		}),
	);
	const list = await t.store.write((db) =>
		t.tools.invocationsInTransaction(db, "child"),
	);
	expect(list).toEqual([
		{
			id: expect.any(String),
			arguments: expect.any(Object),
			operationFingerprint: null,
			toolRevisionId: lookupId,
			stepId: "imp",
			argsDigest: expect.any(String),
			state: "succeeded",
			origin: "candidate-cache",
			superseded: false,
		},
	]);
	expect(
		await t.store.write((db) =>
			t.tools.supersedeInvocationsInTransaction(db, "child"),
		),
	).toBe(1);
	expect(
		await t.store.write((db) => t.tools.observationsInTransaction(db, "child")),
	).toHaveLength(0);
	expect(
		await t.store.write((db) =>
			t.tools.countInTransaction(db, "child", lookupId),
		),
	).toBe(1);
	expect(
		(
			await t.store.write((db) => t.tools.invocationsInTransaction(db, "child"))
		)[0]!.superseded,
	).toBe(true);
	expect(
		await t.store.write((db) =>
			t.tools.supersedeInvocationsInTransaction(db, "child"),
		),
	).toBe(0);
});

test("replay rechecks authority, source revision and supersession before admitting a consumed grant", async () => {
	const t = await setup();
	t.ledger.set("tok", { urls: new Set([URL_A]), owner: "child" });
	const ref = await t.store.write((db) =>
		t.tools.issueCachedGrantInTransaction(db, {
			owner,
			prepared: t.prepared,
			bindingToken: "tok",
			toolId: "web.read",
			arguments: { url: URL_A },
			exactUrl: URL_A,
			deadline: deadline(),
		}),
	);
	const inv = await invoke(t, ref.executionRef, { url: URL_A }, "original");
	const source = {
		sourceId: "s1",
		viewId: "v1",
		url: URL_A,
		title: "A",
		basis: "page" as const,
		fetchedAt: new Date().toISOString(),
		body: "fact",
		truncated: false,
	};
	await t.store.write((db) =>
		t.tools.settleInTransaction(db, inv, {
			state: "succeeded",
			result: {
				observedAt: source.fetchedAt,
				readings: [source],
				hits: [],
				documents: [],
				failures: [],
			},
		}),
	);
	const replay = (step: string) =>
		t.store.write((db) =>
			t.tools.invokeInTransaction(
				db,
				owner,
				ref.executionRef,
				{ url: URL_A },
				step,
				deadline(),
				"p",
				[],
				undefined,
				false,
			),
		);
	expect((await replay("replay")).id).toBe(inv.id);
	expect(t.started).toHaveLength(1);
	expect(
		t.store.read((db) =>
			t.tools.validateEvidenceInTransaction(db, owner, [source]),
		),
	).toBe(true);
	t.setRevision("r2");
	await expect(replay("changed")).rejects.toThrow("agent_budget_exhausted");
	t.setRevision("r1");
	t.ledger.delete("tok");
	await expect(replay("revoked")).rejects.toThrow("cached_source_rejected");
	t.ledger.set("tok", { urls: new Set([URL_A]), owner: "child" });
	await t.store.write((db) =>
		t.tools.supersedeInvocationsInTransaction(db, "child"),
	);
	expect(
		t.store.read((db) =>
			t.tools.validateEvidenceInTransaction(db, owner, [source]),
		),
	).toBe(false);
	await expect(replay("superseded")).rejects.toThrow("agent_budget_exhausted");
	await expect(
		invoke(t, ref.executionRef, { url: URL_A }, "original"),
	).rejects.toThrow("tool_ref_invalid");
	expect(t.started).toHaveLength(1);
});
