import { afterEach, expect, test } from "bun:test";
import { buildSearchSpec } from "../domains/research-routes";
import {
	AAPL_Q,
	PAGE,
	PAGE_B,
	QUESTION,
	SHIZUOKA,
	SHIZUOKA_Q,
	TOKEN,
	keyOf,
	routeHarness,
	type Options,
} from "./research-routes.fixture";

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of open.splice(0)) await close();
});
async function harness(options: Options = {}) {
	const h = await routeHarness(options);
	open.push(h.close);
	return h;
}

test("E01/E02 cold run registers a route after the answer; warm run does not look up or learn", async () => {
	const h = await harness();
	const cold = await h.ask(QUESTION);
	expect(cold.done?.status).toBe("completed");
	expect(cold.answer).toContain("最高26度");
	// The first lookup uses exactly the SearchSpec keywords (no dedicated fetch posing as a search).
	expect(h.counts.lookups).toBe(1);
	expect(h.lookupQueries).toEqual([
		(buildSearchSpec(QUESTION) as { spec: { keywords: string } }).spec.keywords,
	]);
	expect(h.counts.reads).toBe(1);
	expect(h.counts.worker).toBe(2);
	expect(h.counts.answer).toBe(1);
	// Registration happens after the answer, in the background.
	expect(await h.until(() => h.routeState(QUESTION) === "active")).toBe(true);
	expect(h.jobCount("research.skill-author")).toBe(1);
	expect(h.jobCount("research.context-review")).toBe(1);
	expect(h.counts.author).toBe(1);
	expect(h.counts.review).toBe(1);

	const before = { ...h.counts };
	h.state.max = 27;
	const warm = await h.ask(QUESTION);
	expect(warm.done?.status).toBe("completed");
	expect(warm.answer).toContain("最高27度");
	expect(h.counts.lookups).toBe(before.lookups);
	expect(h.counts.reads).toBe(before.reads + 1);
	// Child summary + parent answer = 2 model calls.
	expect(h.counts.worker - before.worker).toBe(1);
	expect(h.counts.answer - before.answer).toBe(1);
	await Bun.sleep(50);
	// A healthy warm run creates no proof, draft or registration job.
	expect(h.jobCount("research.skill-author")).toBe(1);
	expect(h.counts.author).toBe(1);
	expect(
		h.sql<{ n: number }>("SELECT COUNT(*) n FROM research_route_drafts")[0]!.n,
	).toBe(1);
	expect(h.routeState(QUESTION)).toBe("active");
});

test("E01 an observer exception never costs the answer and leaves no partial learning", async () => {
	const h = await harness({
		postAnswer: {
			recordInTransaction() {
				throw new Error("observer_boom");
			},
		},
	});
	const cold = await h.ask(QUESTION);
	expect(cold.done?.status).toBe("completed");
	expect(cold.answer).toContain("最高26度");
	await Bun.sleep(50);
	expect(h.jobCount("research.skill-author")).toBe(0);
	expect(
		h.sql<{ n: number }>("SELECT COUNT(*) n FROM research_route_drafts")[0]!.n,
	).toBe(0);
	expect(h.routeState(QUESTION)).not.toBe("active");
});

test("E01 a full queue skips only the learning; the answer is kept and nothing is half-accepted", async () => {
	const h = await harness({
		queueLimits: { total: 1024, background: 768, scope: 1 },
	});
	// Occupy the only slot of the research scope with a job that never finishes.
	const gate = new Promise<void>(() => {});
	h.queue.registerHandler({
		kind: "test.block",
		payloadVersions: [1],
		schema: (await import("zod")).z.object({}).strict(),
		recovery: "interrupt",
		prepareInTransaction: () => ({ status: "ready", input: null }),
		execute: () => gate,
		settleInTransaction: () => "applied",
		cancelInTransaction: () => {},
	});
	await h.queue.enqueue({
		scope: "research-routes:owner",
		kind: "test.block",
		dedupeKey: "block",
		payload: {},
		lane: "background",
	});
	const cold = await h.ask(QUESTION);
	expect(cold.done?.status).toBe("completed");
	expect(cold.answer).toContain("最高26度");
	await Bun.sleep(50);
	expect(h.jobCount("research.skill-author")).toBe(0);
	expect(
		h.sql<{ n: number }>("SELECT COUNT(*) n FROM research_route_drafts")[0]!.n,
	).toBe(0);
	expect(h.routeState(QUESTION)).not.toBe("active");
});

test("unsupported keys keep the legacy coordinator path and create no ledger key", async () => {
	const h = await harness();
	const run = await h.ask("こんにちは");
	expect(run.done?.status).toBe("completed");
	expect(
		h.sql<{ n: number }>("SELECT COUNT(*) n FROM research_route_keys")[0]!.n,
	).toBe(0);
});

// ---------- T24b: other places, quotes, site failures, races and the management API ----------
const api =
	(h: Awaited<ReturnType<typeof harness>>) =>
	async (
		method: "GET" | "POST",
		path: string,
		body?: unknown,
		headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` },
	) => {
		const init: RequestInit = {
			method,
			headers: { "Content-Type": "application/json", ...headers },
		};
		if (method === "POST") init.body = JSON.stringify(body);
		const res = await h.app.fetch(new Request(`http://localhost${path}`, init));
		return { status: res.status, body: (await res.json()) as any };
	};
async function register(h: Awaited<ReturnType<typeof harness>>, q: string) {
	const run = await h.ask(q);
	expect(run.done?.status).toBe("completed");
	expect(await h.until(() => h.routeState(q) === "active")).toBe(true);
	return run;
}

test("E02 a different place misses the cache and runs a cold lookup without touching the Kamakura site", async () => {
	const h = await harness();
	await register(h, QUESTION);
	const reads = h.readUrls.length;
	const before = { ...h.counts };
	const run = await h.ask(SHIZUOKA_Q);
	expect(run.done?.status).toBe("completed");
	expect(run.answer).toContain("静岡市");
	expect(run.answer).toContain("最高29度");
	expect(h.counts.lookups - before.lookups).toBe(1);
	expect(h.lookupQueries.at(-1)).toBe(
		(buildSearchSpec(SHIZUOKA_Q) as { spec: { keywords: string } }).spec
			.keywords,
	);
	expect(h.readUrls.slice(reads)).toEqual([SHIZUOKA]);
	expect(await h.until(() => h.routeState(SHIZUOKA_Q) === "active")).toBe(true);
	expect(h.routeState(QUESTION)).toBe("active");
});

test("E02 AAPL cold then warm returns the new price with no lookup and no registration job", async () => {
	const h = await harness();
	const cold = await register(h, AAPL_Q);
	expect(cold.answer).toContain("190.5");
	expect(h.counts.lookups).toBe(1);
	const before = { ...h.counts };
	h.state.price = 191.25;
	const warm = await h.ask(AAPL_Q);
	expect(warm.done?.status).toBe("completed");
	expect(warm.answer).toContain("191.25");
	expect(h.counts.lookups).toBe(before.lookups);
	expect(h.counts.reads - before.reads).toBe(1);
	expect(h.counts.worker - before.worker).toBe(1);
	expect(h.counts.answer - before.answer).toBe(1);
	await Bun.sleep(50);
	expect(h.counts.author).toBe(1);
	expect(h.jobCount("research.skill-author")).toBe(1);
});

test("E02 a dead site (404) falls back to a search, answers from site B and registers B only", async () => {
	const h = await harness();
	await register(h, QUESTION);
	h.sites[PAGE]!.mode = "error";
	h.hits.urls = () => [PAGE_B];
	const before = { ...h.counts };
	const readsBefore = h.readUrls.length;
	const run = await h.ask(QUESTION);
	expect(run.done?.status).toBe("completed");
	expect(run.answer).toContain("最高30度");
	expect(h.counts.lookups - before.lookups).toBe(1);
	expect(h.readUrls.slice(readsBefore)).toEqual([PAGE, PAGE_B]);
	// The review pass for B runs after the answer; afterwards only B is used.
	expect(
		await h.until(
			() => h.counts.author === 2 && h.routeState(QUESTION) === "active",
		),
	).toBe(true);
	h.state.maxB = 31;
	const lookups = h.counts.lookups;
	const reads = h.readUrls.length;
	const next = await h.ask(QUESTION);
	expect(next.answer).toContain("最高31度");
	expect(h.counts.lookups).toBe(lookups);
	expect(h.readUrls.slice(reads)).toEqual([PAGE_B]);
});

test("P1 a warm page whose content no longer matches disqualifies the route, searches again and answers from B", async () => {
	const h = await harness();
	await register(h, QUESTION);
	const original = h.sites[PAGE]!.text;
	h.sites[PAGE]!.text = () => original().replace("鎌倉市", "横浜市");
	h.hits.urls = () => [PAGE_B];
	const before = { ...h.counts };
	const readsBefore = h.readUrls.length;
	const run = await h.ask(QUESTION);
	expect(run.done?.status).toBe("completed");
	expect(run.answer).toContain("最高30度");
	expect(h.counts.lookups - before.lookups).toBe(1);
	expect(h.readUrls.slice(readsBefore)).toEqual([PAGE, PAGE_B]);
	// The old version is durably disqualified even though the failed finish was rolled back.
	expect(
		h.sql("SELECT reason FROM research_route_revision_health").length,
	).toBe(1);
	expect(
		await h.until(
			() => h.counts.author === 2 && h.routeState(QUESTION) === "active",
		),
	).toBe(true);
	const reads = h.readUrls.length;
	await h.ask(QUESTION);
	expect(h.readUrls.slice(reads)).toEqual([PAGE_B]);
});

test("P3 a failed check still keeps the real lookup's candidates for the next request", async () => {
	const h = await harness();
	const original = h.sites[PAGE]!.text;
	h.sites[PAGE]!.text = () => original().replace("鎌倉市", "横浜市");
	const run = await h.ask(QUESTION);
	expect(run.done?.status).toBe("completed");
	expect(h.sql("SELECT key FROM research_search_candidates").length).toBe(1);
});

test("E02 timeout on A and failure on B ends within budget without an old value", async () => {
	const h = await harness();
	await register(h, QUESTION);
	h.sites[PAGE]!.mode = "timeout";
	h.sites[PAGE_B]!.mode = "error";
	h.hits.urls = () => [PAGE_B];
	const before = { ...h.counts };
	const reads = h.readUrls.length;
	const run = await h.ask(QUESTION);
	expect(run.done).not.toBeNull();
	expect(run.answer ?? "").not.toContain("最高26度");
	expect(h.counts.lookups - before.lookups).toBe(1);
	expect(h.readUrls.length - reads).toBeLessThanOrEqual(3);
	await Bun.sleep(50);
	expect(h.counts.author).toBe(1);
	expect(h.routeState(QUESTION)).not.toBe("active");
});

test("E02 a guard denial never triggers a replacement search", async () => {
	const h = await harness();
	await register(h, QUESTION);
	h.sites[PAGE]!.mode = "guard";
	const before = { ...h.counts };
	const run = await h.ask(QUESTION);
	expect(run.done).not.toBeNull();
	expect(run.answer ?? "").not.toContain("最高26度");
	expect(h.counts.lookups).toBe(before.lookups);
	await Bun.sleep(50);
	expect(h.counts.author).toBe(1);
});

test("E02 clear during authoring: the late draft is refused, retries return the saved result, a recreated key survives", async () => {
	const h = await harness();
	const call = api(h);
	let release!: () => void;
	h.gates.author = new Promise<void>((r) => (release = r));
	const cold = await h.ask(QUESTION);
	expect(cold.done?.status).toBe("completed");
	expect(await h.until(() => h.counts.author === 1)).toBe(true);
	const listed = await call("GET", "/api/research-routes");
	expect(listed.status).toBe(200);
	const clearBody = {
		requestId: crypto.randomUUID(),
		expectedEpoch: listed.body.epoch,
	};
	const cleared = await call("POST", "/api/research-routes/clear", clearBody);
	expect(cleared.status).toBe(200);
	expect(cleared.body.epoch).toBe(listed.body.epoch + 1);
	release();
	await h.until(() => h.counts.review > 0, 300);
	await Bun.sleep(100);
	expect(h.routeState(QUESTION)).toBeUndefined();
	expect(
		h.sql<{ n: number }>(
			"SELECT COUNT(*) n FROM research_route_drafts WHERE state='activated'",
		)[0]!.n,
	).toBe(0);
	const again = await call("POST", "/api/research-routes/clear", clearBody);
	expect(again).toEqual(cleared);
	// A recreated key in the new epoch is not removed by the replayed clear.
	await register(h, QUESTION);
	const replay = await call("POST", "/api/research-routes/clear", clearBody);
	expect(replay).toEqual(cleared);
	expect(h.routeState(QUESTION)).toBe("active");
	const mismatch = await call("POST", "/api/research-routes/clear", {
		...clearBody,
		expectedEpoch: clearBody.expectedEpoch + 7,
	});
	expect(mismatch.status).toBe(409);
});

test("H01/E02 management API: auth, stale tokens, disable/rediscover, and expired routes stay readable", async () => {
	const h = await harness();
	const call = api(h);
	await register(h, QUESTION);
	const key = keyOf(QUESTION);
	expect(
		(await call("GET", "/api/research-routes", undefined, {})).status,
	).toBe(401);
	expect(
		(
			await call("GET", "/api/research-routes", undefined, {
				Authorization: `Bearer ${TOKEN}`,
				Origin: "http://evil.example",
			})
		).status,
	).toBe(403);
	const list = await call("GET", "/api/research-routes?limit=5");
	expect(list.body.items).toHaveLength(1);
	expect(list.body.items[0].state).toBe("active");
	const detail = await call("GET", `/api/research-routes/${key}`);
	expect(detail.status).toBe(200);
	expect(detail.body.skillRevision?.body).toBeTruthy();
	expect(detail.body.contextProjection).toBeTruthy();
	expect(
		(await call("GET", `/api/research-routes/${"0".repeat(64)}`)).status,
	).toBe(404);

	const stale = await call("POST", `/api/research-routes/${key}/disable`, {
		requestId: crypto.randomUUID(),
		expectedStateToken: "0".repeat(64),
	});
	expect(stale.status).toBe(409);
	const disableId = crypto.randomUUID();
	const disabled = await call("POST", `/api/research-routes/${key}/disable`, {
		requestId: disableId,
		expectedStateToken: detail.body.stateToken,
	});
	expect(disabled.status).toBe(200);
	expect(disabled.body.state).toBe("disabled");
	// Same request id and body replays; same id with a different body conflicts.
	expect(
		await call("POST", `/api/research-routes/${key}/disable`, {
			requestId: disableId,
			expectedStateToken: detail.body.stateToken,
		}),
	).toEqual(disabled);
	expect(
		(
			await call("POST", `/api/research-routes/${key}/rediscover`, {
				requestId: disableId,
				expectedStateToken: disabled.body.stateToken,
			})
		).status,
	).toBe(409);
	// Disabled: a normal answer only, no learning and no automatic revival.
	const jobs = h.jobCount("research.skill-author");
	const answered = await h.ask(QUESTION);
	expect(answered.done?.status).toBe("completed");
	await Bun.sleep(50);
	expect(h.jobCount("research.skill-author")).toBe(jobs);
	expect(h.routeState(QUESTION)).toBe("disabled");
	const re = await call("POST", `/api/research-routes/${key}/rediscover`, {
		requestId: crypto.randomUUID(),
		expectedStateToken: disabled.body.stateToken,
	});
	expect(re.status).toBe(200);
	expect(re.body.state).not.toBe("disabled");

	// An old route is expired but still readable (200, body fields null), never 410.
	const h2 = await harness();
	const call2 = api(h2);
	await register(h2, QUESTION);
	h2.skew.ms = 31 * 24 * 3600_000;
	const old = await call2("GET", `/api/research-routes/${key}`);
	expect(old.status).toBe(200);
	expect(old.body.state).toBe("expired");
	expect(old.body.skillRevision).toBeNull();
	expect(old.body.contextProjection).toBeNull();
});
