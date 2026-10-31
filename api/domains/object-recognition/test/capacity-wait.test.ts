import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStore } from "../../../infrastructure/sqlite";
import { waitFor } from "../../../infrastructure/wait-for";
import { createQueue, migrations as queueMigrations } from "../../queue";
import { createVisualPerception } from "../../larm";
import { visualFetcher, visualImage } from "./analyses.fixture";
import { createObjectRecognition, migrations } from "..";

const close: (() => Promise<void>)[] = [];
afterEach(async () => {
	setSystemTime();
	for (const f of close.splice(0)) await f();
});
/** LARM's single "no free memory" refusal. */
const capacity = (retryAfter?: string) =>
	Response.json(
		{ error: { code: "resource_exhausted", resource: "memory", message: "x" } },
		{
			status: 503,
			headers: retryAfter ? { "Retry-After": retryAfter } : undefined,
		},
	);
/** Moves the clock, so a wait of seconds ends without sleeping that long. */
const later = (ms: number) => setSystemTime(new Date(Date.now() + ms));
const quiet = () => Bun.sleep(150);
const result = {
	kind: "image",
	model: "fixture",
	width: 8,
	height: 6,
	objects: [],
};

async function fixture(
	options: {
		visual?: Parameters<typeof visualFetcher>[0];
		gateway?: (attempt: number, path: string) => Response;
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "capacity-"));
	const store = openStore(join(dir, "db"), [...queueMigrations, ...migrations]);
	const queue = createQueue(store, {
		pollMs: 2,
		resources: { "vision.perception": 1 },
	});
	const f = visualFetcher(options.visual);
	const gatewayCalls: string[] = [];
	let refuse = false;
	const service = createObjectRecognition({
		store,
		queue,
		connection: () => ({
			revision: 1,
			baseUrl: "http://127.0.0.1:9",
			credential: "test",
		}),
		visual: () =>
			createVisualPerception({
				baseUrl: "http://127.0.0.1:9810",
				token: "control-secret",
				audience: "desktop",
				fetch: f.fetcher,
				pollMs: 1,
			}),
		fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
			const path = new URL(String(input)).pathname;
			if (init?.method === "POST" && refuse) {
				gatewayCalls.push(path);
				return options.gateway!(gatewayCalls.length, path);
			}
			return Response.json(result);
		}) as unknown as typeof fetch,
	});
	queue.start();
	close.push(async () => {
		await queue.close(100);
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const image = await visualImage();
	const upload = async () => {
		const id = crypto.randomUUID();
		await service.upload(
			"alice",
			"main",
			new File([image.bytes], "image.png", { type: "image/png" }),
			id,
		);
		return id;
	};
	const sourceId = await upload();
	await waitFor(() => service.get("alice", sourceId).state === "completed");
	const source = service.get("alice", sourceId);
	const a = service.analyses!;
	const input = () => ({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		expectedRevision: source.revision,
		task: "describe" as const,
		query: "説明",
	});
	const get = (id: string) => a.get("alice", source.id, id, "main");
	const creates = () =>
		f.requests.filter(
			(r) => r.method === "POST" && r.path === "/v1/agent-connections",
		);
	return {
		a,
		f,
		get,
		input,
		creates,
		queue,
		service,
		source,
		gatewayCalls,
		/** Uploads a file whose analyze POST the gateway fixture answers. */
		async submit() {
			refuse = true;
			return upload();
		},
		/** Minutes between now and the next try of the one queued job of a subject. */
		nextInMs(subject: string) {
			const job = queue
				.list({ subjectRef: subject, state: "queued" })
				.items.at(-1);
			return job ? Date.parse(job.availableAt) - Date.now() : null;
		},
	};
}

// ---- detail analysis (object-recognition.analysis) ----
test("object-recognition analysis: capacity refusal waits 30 s, sends once more and completes (T1, T10)", async () => {
	const h = await fixture({
		visual: { createResponse: (n) => (n === 1 ? capacity() : undefined) },
	});
	const r = await h.a.create("alice", h.source.id, h.input());
	await waitFor(() => h.get(r.id).capacityWait?.count === 1);
	const waiting = h.get(r.id);
	expect(waiting.state).toBe("queued");
	expect(waiting.errorCode).toBeNull();
	expect(h.nextInMs(r.id)).toBeGreaterThan(25_000);
	expect(h.nextInMs(r.id)).toBeLessThanOrEqual(30_000);
	await quiet();
	expect(h.creates()).toHaveLength(1);
	later(31_000);
	await waitFor(() => h.get(r.id).state === "completed");
	expect(h.creates()).toHaveLength(2);
	expect(h.get(r.id).capacityWait).toMatchObject({ count: 1 });
	expect(h.get(r.id).releaseConfirmed).toBe(true);
});
test("object-recognition analysis: a capacity refusal at the claim releases the connection and sends once more (T9, T10)", async () => {
	const h = await fixture({
		visual: { claim: (n) => (n === 1 ? capacity() : undefined) },
	});
	const r = await h.a.create("alice", h.source.id, h.input());
	await waitFor(() => h.get(r.id).capacityWait?.count === 1);
	await waitFor(() => h.f.requests.some((q) => q.method === "DELETE"));
	await quiet();
	expect(h.creates()).toHaveLength(1);
	expect(h.f.requests.filter((q) => q.path.endsWith("/claim"))).toHaveLength(1);
	later(31_000);
	await waitFor(() => h.get(r.id).state === "completed");
	expect(h.creates()).toHaveLength(2);
	expect(h.f.requests.filter((q) => q.path.endsWith("/claim"))).toHaveLength(2);
});
test("object-recognition analysis: Retry-After 90 moves the next try to 90 s (T2)", async () => {
	const h = await fixture({
		visual: { createResponse: (n) => (n === 1 ? capacity("90") : undefined) },
	});
	const r = await h.a.create("alice", h.source.id, h.input());
	await waitFor(() => h.get(r.id).capacityWait?.count === 1);
	expect(h.nextInMs(r.id)).toBeGreaterThan(85_000);
	expect(h.nextInMs(r.id)).toBeLessThanOrEqual(90_000);
	later(31_000);
	await quiet();
	expect(h.creates()).toHaveLength(1);
	later(60_000);
	await waitFor(() => h.get(r.id).state === "completed");
	expect(h.creates()).toHaveLength(2);
});
test("object-recognition analysis: 30 minutes of refusals stop with larm_capacity_timeout and no more requests (T3)", async () => {
	const h = await fixture({
		visual: { createResponse: () => capacity("300") },
	});
	const r = await h.a.create("alice", h.source.id, h.input());
	let seen = 0;
	for (let i = 0; i < 10; i++) {
		await waitFor(
			() =>
				h.get(r.id).state === "failed" ||
				(h.get(r.id).capacityWait?.count ?? 0) > seen,
		);
		if (h.get(r.id).state === "failed") break;
		seen = h.get(r.id).capacityWait!.count;
		later(301_000);
	}
	const failed = h.get(r.id);
	expect(failed.state).toBe("failed");
	expect(failed.errorCode).toBe("larm_capacity_timeout");
	const sent = h.creates().length;
	expect(sent).toBeLessThanOrEqual(7);
	later(600_000);
	await quiet();
	expect(h.creates()).toHaveLength(sent);
});
test("object-recognition analysis: cancelling during the wait cancels and sends nothing more (T4)", async () => {
	const h = await fixture({ visual: { createResponse: () => capacity() } });
	const r = await h.a.create("alice", h.source.id, h.input());
	await waitFor(() => h.get(r.id).capacityWait?.count === 1);
	await h.a.cancel("alice", h.source.id, r.id, "main");
	expect(h.get(r.id).state).toBe("cancelled");
	later(31_000);
	await quiet();
	expect(h.creates()).toHaveLength(1);
	expect(h.get(r.id).state).toBe("cancelled");
});
test("object-recognition analysis: other refusals fail once as before and are not sent again (T6)", async () => {
	for (const [status, body, code] of [
		[503, { error: "image_model_unavailable" }, "larm_http_503"],
		[
			503,
			{ error: { code: "resource_exhausted", resource: "gpu" } },
			"larm_http_503",
		],
		[429, { error: "busy" }, "larm_http_429"],
	] as const) {
		const h = await fixture({
			visual: { createResponse: () => Response.json(body, { status }) },
		});
		const r = await h.a.create("alice", h.source.id, h.input());
		await waitFor(() => h.get(r.id).state === "failed");
		expect(h.get(r.id).errorCode).toBe(code);
		expect(h.get(r.id).capacityWait).toBeUndefined();
		later(600_000);
		await quiet();
		expect(h.creates()).toHaveLength(1);
		await close.pop()!();
	}
});
test("object-recognition analysis: a claim that is not ready claims the same connection again, creating it once (T12)", async () => {
	const h = await fixture({
		visual: {
			claim: (n) =>
				n < 3
					? Response.json(
							{ error: "provider_semantic_not_ready" },
							{ status: 503 },
						)
					: undefined,
		},
	});
	const r = await h.a.create("alice", h.source.id, h.input());
	await waitFor(() => h.get(r.id).state === "completed");
	expect(h.creates()).toHaveLength(1);
	expect(h.f.requests.filter((q) => q.path.endsWith("/claim"))).toHaveLength(3);
	expect(h.get(r.id).capacityWait).toBeUndefined();
});

// ---- gateway analyze (object-recognition.analyze) ----
test("object-recognition analyze: capacity refusal waits 30 s, sends once more and completes (T1, T10)", async () => {
	const h = await fixture({
		gateway: (n) => (n === 1 ? capacity() : Response.json(result)),
	});
	const id = await h.submit();
	await waitFor(() => h.service.get("alice", id).capacityWait?.count === 1);
	expect(h.service.get("alice", id).state).toBe("queued");
	expect(h.nextInMs(id)).toBeGreaterThan(25_000);
	await quiet();
	expect(h.gatewayCalls).toHaveLength(1);
	later(31_000);
	await waitFor(() => h.service.get("alice", id).state === "completed");
	expect(h.gatewayCalls).toHaveLength(2);
});
test("object-recognition analyze: Retry-After 90 moves the next try to 90 s (T2)", async () => {
	const h = await fixture({
		gateway: (n) => (n === 1 ? capacity("90") : Response.json(result)),
	});
	const id = await h.submit();
	await waitFor(() => h.service.get("alice", id).capacityWait?.count === 1);
	expect(h.nextInMs(id)).toBeGreaterThan(85_000);
	later(31_000);
	await quiet();
	expect(h.gatewayCalls).toHaveLength(1);
	later(60_000);
	await waitFor(() => h.service.get("alice", id).state === "completed");
	expect(h.gatewayCalls).toHaveLength(2);
});
test("object-recognition analyze: 30 minutes of refusals stop with larm_capacity_timeout (T3)", async () => {
	const h = await fixture({ gateway: () => capacity("300") });
	const id = await h.submit();
	let seen = 0;
	for (let i = 0; i < 10; i++) {
		await waitFor(
			() =>
				h.service.get("alice", id).state === "failed" ||
				(h.service.get("alice", id).capacityWait?.count ?? 0) > seen,
		);
		if (h.service.get("alice", id).state === "failed") break;
		seen = h.service.get("alice", id).capacityWait!.count;
		later(301_000);
	}
	expect(h.service.get("alice", id).state).toBe("failed");
	expect(h.service.get("alice", id).errorCode).toBe("larm_capacity_timeout");
	const sent = h.gatewayCalls.length;
	expect(sent).toBeLessThanOrEqual(7);
	later(600_000);
	await quiet();
	expect(h.gatewayCalls).toHaveLength(sent);
});
test("object-recognition analyze: cancelling during the wait sends nothing more (T4)", async () => {
	const h = await fixture({ gateway: () => capacity() });
	const id = await h.submit();
	await waitFor(() => h.service.get("alice", id).capacityWait?.count === 1);
	await h.service.cancel("alice", id);
	expect(h.service.get("alice", id).state).toBe("cancelled");
	later(31_000);
	await quiet();
	expect(h.gatewayCalls).toHaveLength(1);
	expect(h.service.get("alice", id).state).toBe("cancelled");
});
test("object-recognition analyze: other refusals fail once as before and are not sent again (T6)", async () => {
	for (const [status, body, code] of [
		[503, { error: "starting" }, "recognition_busy"],
		[
			503,
			{ error: { code: "resource_exhausted", resource: "gpu" } },
			"recognition_busy",
		],
		[429, { error: "busy" }, "recognition_busy"],
		[500, { error: "boom" }, "recognition_submission_unconfirmed"],
	] as const) {
		const h = await fixture({
			gateway: () => Response.json(body, { status }),
		});
		const id = await h.submit();
		await waitFor(() => h.service.get("alice", id).state === "failed");
		expect(h.service.get("alice", id).errorCode).toBe(code);
		expect(h.service.get("alice", id).capacityWait).toBeUndefined();
		later(600_000);
		await quiet();
		expect(h.gatewayCalls).toHaveLength(1);
		await close.pop()!();
	}
});
