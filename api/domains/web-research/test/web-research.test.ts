import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmFetchError } from "llm-fetch";
import { registerExternalDependents } from "eumenes-memory/sqlite";
import { openStore } from "../../../infrastructure/sqlite";
import { createQueue, migration as queueMigration } from "../../queue";
import {
	createWebResearch,
	migration,
	createWebCache,
	openWebCache,
	registerWebResearch,
	type AcquisitionPort,
} from "..";
import { freshnessDeadline } from "../adapters/llm-fetch";
import {
	submitResearchSchema,
	type ResearchRequest,
	type ResearchResult,
} from "../contracts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
function response(): ResearchResult {
	return {
		provider: "llm-fetch@0.1.2",
		observedAt: new Date(1000000).toISOString(),
		cache: "bypass",
		hits: [],
		failures: [],
		documents: [
			{
				url: "https://example.com/",
				title: "Example",
				text: "Evidence",
				fetchedAt: new Date(1000000).toISOString(),
				truncated: false,
				trust: "untrusted",
				tainted: true,
				verification: "source_read",
				guardDecision: "allow",
				guardReasonCodes: [],
			},
		],
	};
}
function setup(
	port?: AcquisitionPort,
	maxEntries = 5000,
	acquisitionTimeoutMs = 15000,
) {
	const dir = mkdtempSync(join(tmpdir(), "web-research-"));
	const clock = { t: 1000000 };
	const store = openStore(join(dir, "main.db"), [queueMigration, migration]);
	const cacheStore = openWebCache(join(dir, "cache.db"));
	const cache = createWebCache(cacheStore, {
		now: () => clock.t,
		maxEntries,
		idleTtlMs: 1000,
	});
	const queue = createQueue(store, {
		now: () => clock.t,
		resources: { "web.fetch": 2 },
	});
	let calls = 0;
	const acquisition: AcquisitionPort = port ?? {
		async execute() {
			calls++;
			return { result: response(), freshUntilMs: clock.t + 500 };
		},
		async close() {},
	};
	const service = createWebResearch({
		store,
		queue,
		cache,
		acquisition,
		now: () => clock.t,
		acquisitionTimeoutMs,
	});
	cleanup.push(async () => {
		await queue.close(100);
		await service.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return {
		store,
		cacheStore,
		cache,
		queue,
		service,
		clock,
		calls: () => calls,
	};
}
function read(extra: Partial<ResearchRequest> = {}) {
	return {
		requestId: crypto.randomUUID(),
		operation: "read",
		url: "https://example.com/",
		retention: "stable",
		freshness: "normal",
		...extra,
	};
}
async function until(
	condition: () => boolean,
	tick: () => Promise<void> = async () => {},
) {
	for (let i = 0; i < 150; i++) {
		await tick();
		if (condition()) return;
		await Bun.sleep(5);
	}
	throw new Error("condition timeout");
}

test("API idempotency, validation, run polling and cancellation are backed by Queue", async () => {
	const { service, queue } = setup();
	const app = new Hono();
	registerWebResearch(app, service);
	const input = read();
	const request = (value: unknown) =>
		app.request("/api/web-research/runs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(value),
		});
	const first = await request(input);
	expect(first.status).toBe(202);
	const run = await first.json();
	expect((await (await request(input)).json()).id).toBe(run.id);
	await expect(
		service.submit({ ...input, url: "https://example.org/" }),
	).rejects.toThrow("request_conflict");
	await expect(
		service.submit({ ...input, url: "file:///private" }),
	).rejects.toThrow("invalid_web_research_input");
	await expect(
		service.submit({ ...input, operation: "weather" }),
	).rejects.toThrow("invalid_web_research_input");
	await until(() => service.get(run.id)?.status === "completed", queue.tick);
	expect(service.get(run.id)?.result?.documents[0]?.trust).toBe("untrusted");
	const pending = await service.submit(read({ url: "https://example.org/" }));
	expect((await service.cancel(pending.id))?.status).toBe("cancelled");
	expect(queue.get(pending.jobId)?.state).toBe("cancelled");
});

test("stable document hits reuse; live and lookup bypass persistent cache; GET expires without a new search", async () => {
	const { service, queue, calls, clock, cache } = setup();
	const first = await service.submit(read());
	await until(() => service.get(first.id)?.status === "completed", queue.tick);
	await until(() => cache.status().entries === 1);
	const second = await service.submit(read());
	await until(() => service.get(second.id)?.status === "completed", queue.tick);
	expect(calls()).toBe(1);
	expect(service.get(second.id)?.result?.cache).toBe("hit");
	const live = await service.submit(read({ freshness: "live" }));
	await until(() => service.get(live.id)?.status === "completed", queue.tick);
	expect(calls()).toBe(2);
	const lookup = await service.submit({
		requestId: crypto.randomUUID(),
		operation: "lookup",
		query: "today",
		freshness: "live",
	});
	await until(() => service.get(lookup.id)?.status === "completed", queue.tick);
	expect(calls()).toBe(3);
	clock.t += 15 * 60000;
	expect(service.get(first.id)?.resultExpired).toBe(true);
	expect(service.get(first.id)?.result).toBeNull();
	expect(calls()).toBe(3);
});

test("fresh deadline does not extend on access; idle expiry sweeps bodies and cache mappings", async () => {
	const { cache, clock, cacheStore } = setup();
	const request = submitResearchSchema.parse(read());
	await cache.put(request, response(), clock.t + 500, cache.generation());
	clock.t += 200;
	const hit = cache.get(request)!;
	expect(hit).not.toBeNull();
	expect(await cache.use(hit)).toBe(true);
	clock.t += 300;
	expect(cache.get(request)).toBeNull();
	clock.t += 700;
	await cache.sweep();
	expect(cache.status().entries).toBe(0);
	expect(
		cacheStore.read((db) =>
			db.query("SELECT count(*) AS n FROM memory_record_body").get(),
		),
	).toEqual({ n: 0 });
	expect(cacheStore.read((db) => db.query("PRAGMA auto_vacuum").get())).toEqual(
		{ auto_vacuum: 2 },
	);
});

test("LRU capacity and clear generation refuse late repopulation", async () => {
	const { cache, clock } = setup(undefined, 2);
	const r1 = submitResearchSchema.parse(read({ url: "https://example.com/1" }));
	const r2 = submitResearchSchema.parse(read({ url: "https://example.com/2" }));
	const r3 = submitResearchSchema.parse(read({ url: "https://example.com/3" }));
	const gen = cache.generation();
	await cache.put(r1, response(), clock.t + 500, gen);
	clock.t++;
	await cache.put(r2, response(), clock.t + 500, gen);
	clock.t++;
	await cache.use(cache.get(r1)!);
	await cache.put(r3, response(), clock.t + 500, gen);
	expect(cache.get(r1)).not.toBeNull();
	expect(cache.get(r2)).toBeNull();
	await cache.clear();
	expect(cache.status().entries).toBe(0);
	expect(await cache.put(r1, response(), clock.t + 500, gen)).toBe(false);
});

test("inflight sharing respects cancellation of individual subscribers", async () => {
	let resolve!: (value: {
		result: ResearchResult;
		freshUntilMs: number | null;
	}) => void;
	let observed!: AbortSignal;
	let calls = 0;
	const { service, queue } = setup({
		execute(_request, signal) {
			observed = signal;
			calls++;
			return new Promise((r) => {
				resolve = r;
			});
		},
		async close() {},
	});
	const one = await service.submit(
		read({ retention: "none", freshness: "live" }),
	);
	const two = await service.submit(
		read({ retention: "none", freshness: "live" }),
	);
	await until(
		() =>
			service.get(one.id)?.status === "running" &&
			service.get(two.id)?.status === "running" &&
			calls === 1,
		queue.tick,
	);
	await service.cancel(one.id);
	expect(observed.aborted).toBe(false);
	resolve({ result: response(), freshUntilMs: null });
	await until(() => service.get(two.id)?.status === "completed", queue.tick);
	expect(service.get(one.id)?.status).toBe("cancelled");
	expect(service.get(one.id)?.result).toBeNull();
	expect(calls).toBe(1);
});

test("clear during acquisition rejects old result and does not write a completed cache", async () => {
	let resolve!: (value: {
		result: ResearchResult;
		freshUntilMs: number | null;
	}) => void;
	const { service, queue, cache, clock } = setup({
		execute() {
			return new Promise((r) => {
				resolve = r;
			});
		},
		async close() {},
	});
	const run = await service.submit(read());
	await until(() => Boolean(resolve), queue.tick);
	await cache.clear();
	resolve({ result: response(), freshUntilMs: clock.t + 500 });
	await until(() => service.get(run.id)?.status === "failed", queue.tick);
	expect(service.get(run.id)?.errorCode).toBe("web_cache_changed");
	expect(cache.status().entries).toBe(0);
});

test("main settle failure never exposes a result or writes the cache", async () => {
	const { store, service, queue, cache } = setup();
	await store.write((db) =>
		db.exec(
			"CREATE TRIGGER reject_result BEFORE UPDATE OF status ON web_research_runs WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT, 'fixture'); END",
		),
	);
	const run = await service.submit(read());
	await until(() => queue.get(run.jobId)?.state === "failed", queue.tick);
	expect(service.get(run.id)?.status).toBe("failed");
	expect(service.get(run.id)?.errorCode).toBe("settle_failed");
	expect(service.get(run.id)?.result).toBeNull();
	expect(cache.status().entries).toBe(0);
});

test("guard refusal is a finite error, never stored as provider text or retried", async () => {
	let calls = 0;
	const { service, queue, store, cache } = setup({
		async execute() {
			calls++;
			throw new LlmFetchError("GUARD_DENIED", "secret upstream content", {
				guardDecision: "require_approval",
				guardReasonCodes: ["INSPECTION_INCOMPLETE"],
			});
		},
		async close() {},
	});
	const run = await service.submit(read());
	await until(() => service.get(run.id)?.status === "failed", queue.tick);
	expect(service.get(run.id)?.errorCode).toBe("web_guard_requires_approval");
	expect(
		JSON.stringify(
			store.read((db) => db.query("SELECT * FROM web_research_runs").all()),
		),
	).not.toContain("secret upstream content");
	expect(cache.status().entries).toBe(0);
	expect(calls).toBe(1);
});

test("HTTP retention honors no-store, revalidation, age, expires, variation and personalization", () => {
	const cases: Record<string, string>[] = [
		{ "cache-control": "no-store" },
		{ "cache-control": "public, no-cache" },
		{ "cache-control": "private=max-age" },
		{ "cache-control": "max-age=broken" },
		{ "cache-control": "max-age=60, max-age=broken" },
		{ age: "1e2" },
		{ age: "" },
		{ "cache-control": "max-age=10", date: "invalid" },
		{ vary: "Accept-Language" },
		{ "set-cookie": "session" },
		{ "cache-control": "max-age=2", age: "3" },
		{ expires: "Thu, 01 Jan 1970 00:00:00 GMT" },
	];
	for (const headers of cases)
		expect(freshnessDeadline(headers, 10000)).toBeNull();
	expect(
		freshnessDeadline({ "cache-control": "max-age=10", age: "2" }, 10000),
	).toBe(18000);
	expect(freshnessDeadline({ "cache-control": "max-age=1000000" }, 10000)).toBe(
		86410000,
	);
});

test("refreshing an existing key at capacity preserves other pages and prunes the previous body", async () => {
	const { cache, clock, cacheStore } = setup(undefined, 2);
	const first = submitResearchSchema.parse(read()),
		second = submitResearchSchema.parse(read({ url: "https://example.org/" }));
	const generation = cache.generation();
	expect(await cache.put(first, response(), clock.t + 500, generation)).toBe(
		true,
	);
	clock.t++;
	expect(await cache.put(second, response(), clock.t + 500, generation)).toBe(
		true,
	);
	clock.t++;
	const updated = response();
	updated.documents[0]!.text = "Replacement evidence";
	expect(await cache.put(first, updated, clock.t + 500, generation)).toBe(true);
	expect(cache.get(first)?.result.documents[0]?.text).toBe(
		"Replacement evidence",
	);
	expect(cache.get(second)).not.toBeNull();
	expect(cache.status().entries).toBe(2);
	expect(
		cacheStore.read(
			(db) =>
				db
					.query<{ count: number }, []>(
						"SELECT count(*) AS count FROM memory_record_body",
					)
					.get()!.count,
		),
	).toBe(2);
});

test("clearing the document cache does not invalidate an unrelated live lookup", async () => {
	let resolve!: (value: { result: ResearchResult; freshUntilMs: null }) => void;
	const { service, queue, cache } = setup({
		execute: () => new Promise((r) => (resolve = r)),
		async close() {},
	});
	const run = await service.submit({
		requestId: crypto.randomUUID(),
		operation: "lookup",
		query: "today",
	});
	await until(() => Boolean(resolve), queue.tick);
	await cache.clear();
	resolve({ result: response(), freshUntilMs: null });
	await until(
		() => !["queued", "running"].includes(service.get(run.id)!.status),
		queue.tick,
	);
	expect(service.get(run.id)?.status).toBe("completed");
});

test("a successful fresh response that disallows retention invalidates the previous saved body", async () => {
	const { service, queue, cache, clock } = setup({
		async execute() {
			return { result: response(), freshUntilMs: null };
		},
		async close() {},
	});
	const request = submitResearchSchema.parse(read());
	await cache.put(request, response(), clock.t + 500, cache.generation());
	const run = await service.submit(read({ freshness: "live" }));
	await until(() => service.get(run.id)?.status === "completed", queue.tick);
	await Bun.sleep(0);
	expect(cache.get(request)).toBeNull();
	expect(cache.status().entries).toBe(0);
});

test("JSON escaping truncates large successful results rather than turning them into acquisition failures", async () => {
	const result = response();
	result.documents = Array.from({ length: 3 }, () => ({
		...result.documents[0]!,
		text: "\u0001".repeat(12000),
	}));
	const { service, queue } = setup({
		async execute() {
			return { result, freshUntilMs: null };
		},
		async close() {},
	});
	const run = await service.submit(read({ retention: "none" }));
	await until(
		() => !["queued", "running"].includes(service.get(run.id)!.status),
		queue.tick,
	);
	const completed = service.get(run.id)!;
	expect(completed.status).toBe("completed");
	expect(
		Buffer.byteLength(JSON.stringify(completed.result)),
	).toBeLessThanOrEqual(32 * 1024);
	expect(completed.result?.documents.some((doc) => doc.truncated)).toBe(true);
});

test("same-clock admissions evict the previous page rather than the newly fetched page", async () => {
	const { cache, clock } = setup(undefined, 1);
	for (let i = 0; i < 8; i++) {
		const request = submitResearchSchema.parse(
			read({ url: `https://example.com/${i}` }),
		);
		expect(
			await cache.put(request, response(), clock.t + 500, cache.generation()),
		).toBe(true);
		expect(cache.get(request)).not.toBeNull();
	}
});

test("a rolled-back Queue settlement does not publish a result or evict a successful delivery", async () => {
	const { store, service, queue } = setup();
	let firstId = "";
	for (let i = 0; i < 64; i++) {
		const run = await service.submit(read());
		firstId ||= run.id;
		await until(() => service.get(run.id)?.status === "completed", queue.tick);
	}
	await store.write((db) =>
		db.exec(
			"CREATE TRIGGER reject_queue_success BEFORE UPDATE OF state ON queue_jobs WHEN NEW.state='completed' AND NEW.kind='web-research.acquire' BEGIN SELECT RAISE(ABORT,'fixture'); END",
		),
	);
	const rejected = await service.submit(read());
	await until(() => service.get(rejected.id)?.status === "failed", queue.tick);
	expect(service.get(rejected.id)?.result).toBeNull();
	expect(service.get(firstId)?.resultExpired).toBe(false);
});

test("Expires freshness subtracts upstream Age, using the server Date rather than the local clock", () => {
	expect(
		freshnessDeadline(
			{
				date: new Date(10000).toUTCString(),
				expires: new Date(20000).toUTCString(),
				age: "15",
			},
			10000,
		),
	).toBeNull();
	expect(
		freshnessDeadline(
			{
				date: new Date(30000).toUTCString(),
				expires: new Date(40000).toUTCString(),
			},
			10000,
		),
	).toBe(20000);
});

test("the acquisition deadline releases Queue resources even when the adapter ignores abort", async () => {
	let resolve!: (value: { result: ResearchResult; freshUntilMs: null }) => void;
	const { service, queue, cache } = setup(
		{ execute: () => new Promise((r) => (resolve = r)), async close() {} },
		5000,
		10,
	);
	const run = await service.submit(read({ retention: "none" }));
	await until(() => service.get(run.id)?.status === "failed", queue.tick);
	expect(service.get(run.id)?.errorCode).toBe("web_timeout");
	expect(queue.get(run.jobId)?.state).toBe("failed");
	resolve({ result: response(), freshUntilMs: null });
	await Bun.sleep(0);
	expect(service.get(run.id)?.result).toBeNull();
	expect(cache.status().entries).toBe(0);
});

test("same URL cacheable acquisitions are serialized, including live bypasses", async () => {
	let calls = 0;
	const pending: ((value: {
		result: ResearchResult;
		freshUntilMs: number | null;
	}) => void)[] = [];
	const { service, queue, clock, cache } = setup({
		execute: () => {
			calls++;
			return new Promise((r) => pending.push(r));
		},
		async close() {},
	});
	const older = await service.submit(read());
	await until(() => calls === 1, queue.tick);
	const newer = await service.submit(read({ freshness: "live" }));
	await queue.tick();
	expect(calls).toBe(1);
	pending.shift()!({ result: response(), freshUntilMs: clock.t + 500 });
	await until(() => calls === 2, queue.tick);
	const fresh = response();
	fresh.documents[0]!.text = "latest source";
	pending.shift()!({ result: fresh, freshUntilMs: clock.t + 500 });
	await until(() => service.get(newer.id)?.status === "completed", queue.tick);
	await until(
		() =>
			cache.get(submitResearchSchema.parse(read()))?.result.documents[0]
				?.text === "latest source",
	);
	expect(service.get(older.id)?.status).toBe("completed");
});

test("network delay and local guard time consume HTTP freshness without extending max-age", () => {
	expect(
		freshnessDeadline({ "cache-control": "max-age=10", age: "2" }, 20000, {
			requestedAtMs: 10000,
			receivedAtMs: 15000,
		}),
	).toBeNull();
	expect(
		freshnessDeadline({ "cache-control": "max-age=10", age: "2" }, 18000, {
			requestedAtMs: 15000,
			receivedAtMs: 16000,
		}),
	).toBe(23000);
});

test("cache shutdown waits for a concurrent clear and refuses later admissions", async () => {
	const { cache, clock } = setup();
	const request = submitResearchSchema.parse(read());
	await cache.put(request, response(), clock.t + 500, cache.generation());
	const generation = cache.generation();
	const clearing = cache.clear();
	const closing = cache.close();
	await clearing;
	await closing;
	expect(await cache.put(request, response(), clock.t + 500, generation)).toBe(
		false,
	);
});

test("cache keys reuse the same HTTP resource across URL fragment variants", async () => {
	const { cache, clock } = setup();
	const first = submitResearchSchema.parse(
		read({ url: "https://example.com/#first" }),
	);
	const second = submitResearchSchema.parse(
		read({ url: "https://example.com/#second" }),
	);
	await cache.put(first, response(), clock.t + 500, cache.generation());
	expect(cache.get(second)).not.toBeNull();
});

test("freshness header names are case insensitive and conflicting values are not reused", () => {
	expect(freshnessDeadline({ "Cache-Control": "no-store" }, 10000)).toBeNull();
	expect(freshnessDeadline({ Age: "1", age: "2" }, 10000)).toBeNull();
	expect(
		freshnessDeadline({ "Cache-Control": "max-age=10", Age: "2" }, 10000),
	).toBe(18000);
});

test("clear reports protected cache sources instead of claiming all data was deleted", async () => {
	const { cache, cacheStore, clock } = setup();
	const request = submitResearchSchema.parse(read());
	await cache.put(request, response(), clock.t + 500, cache.generation());
	const hit = cache.get(request)!;
	await cacheStore.write((db) =>
		registerExternalDependents(db, {
			contractVersion: 1,
			access: {
				principal: "local:owner",
				scopeKeys: ["web:owner"],
				purpose: "research.read",
				policyRevision: "1",
			},
			scopeKey: "web:owner",
			clock: { atMs: clock.t },
			dependents: [
				{
					providerRef: "fixture",
					externalId: "report",
					dependsOn: [
						{
							type: "source",
							id: JSON.stringify(["memory", "record", hit.recordId, "text"]),
						},
					],
				},
			],
		}),
	);
	await expect(cache.clear()).rejects.toThrow("web_cache_clear_blocked");
	expect(cache.status().entries).toBe(1);
});

test("an acquisition cleanup error does not prevent the cache writer from closing", async () => {
	const { service, cacheStore } = setup({
		async execute() {
			return { result: response(), freshUntilMs: null };
		},
		close() {
			throw new Error("fixture close failed");
		},
	});
	await service.close();
	expect(() => cacheStore.read((db) => db.query("SELECT 1").get())).toThrow(
		"database_closing",
	);
});
