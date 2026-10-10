import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../infrastructure/sqlite";
import {
	migration as conversationMigration,
	avatarMotionMigration as conversationAvatarMotionMigration,
	answerDeliveryMigration as conversationAnswerDeliveryMigration,
	createConversationService,
} from "../domains/conversation";
import {
	createDialogueService,
	migration as dialogueMigration,
	queueLinkMigration,
} from "../domains/dialogue";
import type { LarmPort } from "../domains/larm";
import { createQueue, migration as queueMigration } from "../domains/queue";
import {
	createScheduler,
	migration as schedulerMigration,
} from "../domains/scheduler";
import {
	createVoiceDialogue,
	migration as voiceMigration,
	sequenceMigration as voiceSequenceMigration,
} from "../domains/voice-dialogue";
import {
	createWebResearch,
	migration as webMigration,
	type WebResearchService,
} from "../domains/web-research";
import { createApp } from "./app";
import { appModules } from "./app-modules";
import { createChanges, type Changes } from "./events";

const webServices: WebResearchService[] = [];
const dirs: string[] = [];
const stores: SqliteStore[] = [];
const streams: Changes[] = [];
afterEach(async () => {
	for (const service of webServices.splice(0)) await service.close();
	for (const stream of streams.splice(0)) stream.close();
	for (const s of stores.splice(0)) await s.close().catch(() => {});
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const token = "t".repeat(32);
const auth = {
	authorization: `Bearer ${token}`,
	"content-type": "application/json",
};

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-app-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db.sqlite3"), [
		conversationMigration,
		conversationAvatarMotionMigration,
		conversationAnswerDeliveryMigration,
		dialogueMigration,
		voiceMigration,
		queueMigration,
		schedulerMigration,
		queueLinkMigration,
		voiceSequenceMigration,
		webMigration,
		"SELECT 1", // retired continuity slot
	]);
	stores.push(store);
	const changes = createChanges({ debounceMs: 1 });
	streams.push(changes);
	store.onCommit(() => changes.publish());
	const clock = { t: Date.parse("2026-03-01T00:00:00Z") };
	const larm: LarmPort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		answer: async () => "予約への回答",
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		close: async () => {},
	};
	const queue = createQueue(store);
	const scheduler = createScheduler(store, queue, {
		now: () => clock.t,
		sleep: () => new Promise(() => {}),
	});
	const conversation = createConversationService(store);
	const dialogue = createDialogueService({ store, conversation, larm, queue });
	scheduler.registerTarget(dialogue.promptTarget);
	const voice = createVoiceDialogue(store, dialogue, larm);
	const webResearch = createWebResearch({
		store,
		queue,
		acquisition: {
			async execute() {
				throw new Error("fixture_unused");
			},
			async close() {},
		},
	});
	webServices.push(webResearch);
	const app = createApp({
		token,
		origin: "http://127.0.0.1:5173",
		modules: appModules({
			changes,
			conversation,
			dialogue,
			voice,
			larm,
			queue,
			scheduler,
			webResearch,
		}),
	});
	const call = (
		path: string,
		body?: unknown,
		headers: Record<string, string> = auth,
	) =>
		app.request(
			path,
			body === undefined
				? { headers }
				: { method: "POST", headers, body: JSON.stringify(body) },
		);
	return { app, call, queue, scheduler, clock, dialogue, larm, conversation };
}

test("status polling is passive and explicit reconnect requires auth and origin", async () => {
	const h = setup();
	let connections = 0;
	h.larm.connect = async () => {
		connections++;
	};
	for (let i = 0; i < 3; i++)
		expect((await h.call("/api/status")).status).toBe(200);
	expect(connections).toBe(0);
	expect(
		(await h.app.request("/api/larm/connect", { method: "POST" })).status,
	).toBe(401);
	expect(
		(
			await h.call(
				"/api/larm/connect",
				{},
				{ ...auth, origin: "http://evil.example" },
			)
		).status,
	).toBe(403);
	expect(connections).toBe(0);
	const response = await h.call("/api/larm/connect", {});
	expect(response.status).toBe(200);
	expect(connections).toBe(1);
	expect(await response.json()).toEqual({
		service: "eumenes",
		larm: { state: "ready", capabilities: ["llm"] },
	});
});

test("auth and origin apply to the new endpoints", async () => {
	const h = setup();
	for (const path of [
		"/api/events",
		"/api/jobs",
		"/api/queue/status",
		"/api/schedules",
	]) {
		expect((await h.app.request(path)).status).toBe(401);
		expect(
			(
				await h.app.request(path, {
					headers: { ...auth, origin: "http://evil.example" },
				})
			).status,
		).toBe(403);
	}
	expect(
		(await h.app.request("/api/schedules", { method: "POST", body: "{}" }))
			.status,
	).toBe(401);
});

test("register → fire → history → pause/resume → cancel through the API", async () => {
	const h = setup();
	h.queue.start();
	const body = {
		requestId: crypto.randomUUID(),
		target: {
			kind: "dialogue.prompt",
			payload: { conversationId: "daily", text: "状況を教えて" },
		},
		schedule: {
			type: "interval",
			anchor: "2026-03-01T00:05:00Z",
			intervalMs: 600_000,
		},
	};
	const created = await h.call("/api/schedules", body);
	expect(created.status).toBe(201);
	const schedule = (await created.json()) as {
		id: string;
		revision: number;
		nextDueAt: string;
		misfirePolicy: string;
	};
	expect(schedule.nextDueAt).toBe("2026-03-01T00:05:00.000Z");
	expect(schedule.misfirePolicy).toBe("coalesce");
	const again = await h.call("/api/schedules", body);
	expect(((await again.json()) as { id: string }).id).toBe(schedule.id);
	expect(
		(
			await h.call("/api/schedules", {
				...body,
				schedule: {
					type: "interval",
					anchor: "2026-03-01T00:05:00Z",
					intervalMs: 700_000,
				},
			})
		).status,
	).toBe(409);
	expect(
		(
			await h.call("/api/schedules", {
				...body,
				requestId: crypto.randomUUID(),
				target: { kind: "shell.exec", payload: { cmd: "rm" } },
			})
		).status,
	).toBe(400);
	expect(
		(
			await h.call("/api/schedules", {
				...body,
				requestId: crypto.randomUUID(),
				target: { kind: "dialogue.prompt", payload: { text: "" } },
			})
		).status,
	).toBe(400);
	expect(
		(
			await h.call("/api/schedules", {
				...body,
				requestId: crypto.randomUUID(),
				schedule: { type: "once", at: "2026-03-01T00:05:00" },
			})
		).status,
	).toBe(400);

	h.clock.t = Date.parse("2026-03-01T00:05:30Z");
	await h.scheduler.tick();
	const occurrences = (await (
		await h.call(`/api/schedules/${schedule.id}/occurrences`)
	).json()) as {
		items: Array<{ state: string; jobId: string; subjectRef: string }>;
	};
	expect(occurrences.items).toHaveLength(1);
	const occ = occurrences.items[0];
	expect(occ?.state).toBe("dispatched");
	for (let i = 0; i < 200; i++) {
		if (h.dialogue.get(occ?.subjectRef ?? "")?.status === "completed") break;
		await new Promise((r) => setTimeout(r, 5));
	}
	const run = (await (await h.call(`/api/runs/${occ?.subjectRef}`)).json()) as {
		status: string;
		sourceKind: string;
		scheduleId: string;
		jobId: string;
	};
	expect(run).toMatchObject({
		status: "completed",
		sourceKind: "schedule",
		scheduleId: schedule.id,
		jobId: occ?.jobId,
	});
	const job = (await (await h.call(`/api/jobs/${occ?.jobId}`)).json()) as {
		state: string;
		lane: string;
		subjectRef: string;
	};
	expect(job).toMatchObject({
		state: "completed",
		lane: "background",
		subjectRef: occ?.subjectRef,
	});
	const attempts = (await (
		await h.call(`/api/jobs/${occ?.jobId}/attempts`)
	).json()) as Array<{ outcome: string }>;
	expect(attempts.map((a) => a.outcome)).toEqual(["completed"]);
	const status = (await (await h.call("/api/queue/status")).json()) as {
		lanes: Record<string, { queued: number }>;
		openJobs: number;
	};
	expect(status.openJobs).toBe(0);
	const list = (await (await h.call("/api/jobs?limit=1")).json()) as {
		items: unknown[];
		nextCursor: string | null;
	};
	expect(list.items).toHaveLength(1);
	expect((await h.call("/api/jobs?limit=500")).status).toBe(400);

	const paused = await h.call(`/api/schedules/${schedule.id}/pause`, {
		expectedRevision: schedule.revision,
	});
	expect(paused.status).toBe(200);
	const stale = await h.call(`/api/schedules/${schedule.id}/pause`, {
		expectedRevision: schedule.revision,
	});
	expect(stale.status).toBe(409);
	const pausedBody = (await paused.json()) as {
		revision: number;
		state: string;
	};
	const resumed = await h.call(`/api/schedules/${schedule.id}/resume`, {
		expectedRevision: pausedBody.revision,
	});
	const resumedBody = (await resumed.json()) as {
		revision: number;
		state: string;
	};
	expect(resumedBody.state).toBe("active");
	const cancelled = await h.call(`/api/schedules/${schedule.id}/cancel`, {
		expectedRevision: resumedBody.revision,
	});
	expect(((await cancelled.json()) as { state: string }).state).toBe(
		"cancelled",
	);
	expect(
		(
			await h.call(`/api/schedules/${schedule.id}/resume`, {
				expectedRevision: 99,
			})
		).status,
	).toBe(409);
	expect((await h.call("/api/schedules/missing")).status).toBe(404);
	expect((await h.call("/api/jobs/missing")).status).toBe(404);
	// there is no external enqueue endpoint
	expect(
		(await h.call("/api/jobs", { kind: "dialogue.generate" })).status,
	).toBe(404);
	await h.queue.close(100);
});

test("full queue is reported as 503 for submissions", async () => {
	const h = setup();
	const store = stores[0] as SqliteStore;
	const small = createQueue(store, {
		limits: { total: 0, background: 0, scope: 0 },
	});
	const dialogue = createDialogueService({
		store,
		conversation: createConversationService(store),
		larm: {
			status: () => ({ state: "ready", capabilities: [] }),
			connect: async () => {},
			answer: async () => "",
			transcribe: async () => "",
			speak: async () => new Uint8Array(),
			close: async () => {},
		},
		queue: small,
	});
	const app = createApp({
		token,
		origin: "http://127.0.0.1:5173",
		modules: appModules({
			conversation: createConversationService(store),
			dialogue,
			voice: createVoiceDialogue(store, dialogue, {
				status: () => ({ state: "ready", capabilities: [] }),
				connect: async () => {},
				answer: async () => "",
				transcribe: async () => "",
				speak: async () => new Uint8Array(),
				close: async () => {},
			}),
			larm: {
				status: () => ({ state: "ready", capabilities: [] }),
				connect: async () => {},
			},
			queue: small,
			scheduler: h.scheduler,
		}),
	});
	const response = await app.request("/api/runs", {
		method: "POST",
		headers: auth,
		body: JSON.stringify({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "hi",
		}),
	});
	expect(response.status).toBe(503);
	expect(((await response.json()) as { error: string }).error).toBe(
		"queue_full",
	);
});

test("authenticated SSE notifies a background commit and the existing API supplies the snapshot", async () => {
	const h = setup();
	const abort = new AbortController();
	const response = await h.app.request("/api/events", {
		headers: auth,
		signal: abort.signal,
	});
	const reader = response.body!.getReader();
	const decode = (bytes?: Uint8Array) => new TextDecoder().decode(bytes);
	try {
		expect(response.status).toBe(200);
		expect(decode((await reader.read()).value)).toContain("event: reset");
		await h.conversation.append({
			id: "external",
			conversationId: "main",
			role: "user",
			text: "通知で更新",
			createdAt: new Date().toISOString(),
			runId: null,
		});
		const notification = decode((await reader.read()).value);
		expect(notification).toContain("event: change");
		expect(notification).not.toContain("通知で更新");
		expect(
			await (await h.call("/api/conversations/main")).json(),
		).toMatchObject({ messages: [{ text: "通知で更新" }] });
		abort.abort();
		expect((await reader.read()).done).toBe(true);
	} finally {
		await reader.cancel();
	}
});

test("replay endpoints split text and synthesize one clause, with auth and limits", async () => {
	const { call } = setup();
	const split = await call("/api/voice/replay/sentences", {
		text: "今日は晴れです。明日は雨です。",
	});
	expect(split.status).toBe(200);
	expect(await split.json()).toEqual({
		sentences: ["今日は晴れです。", "明日は雨です。"],
	});
	const audio = await call("/api/voice/replay/audio", {
		text: "今日は晴れです。",
	});
	expect(audio.status).toBe(200);
	expect(audio.headers.get("content-type")).toBe("audio/wav");
	expect(
		(await call("/api/voice/replay/audio", { text: "あ".repeat(401) })).status,
	).toBe(400);
	expect(
		(await call("/api/voice/replay/sentences", { text: "x" }, {})).status,
	).toBe(401);
});

test("sample endpoint validates unsaved voice settings and returns audio", async () => {
	const { call } = setup();
	const ok = await call("/api/voice/sample", { voice: "Zundamon", speed: 1.2 });
	expect(ok.status).toBe(200);
	expect(ok.headers.get("content-type")).toBe("audio/wav");
	expect((await call("/api/voice/sample", { speed: 3 })).status).toBe(400);
	expect((await call("/api/voice/sample", { extra: 1 })).status).toBe(400);
	expect((await call("/api/voice/sample", {}, {})).status).toBe(401);
});

test("oversized JSON bodies are rejected with 413 and normal requests pass", async () => {
	const h = setup();
	const big = await h.app.request("/api/conversations", {
		method: "POST",
		headers: { ...auth, "content-length": String(2 * 1024 * 1024) },
		body: "{}",
	});
	expect(big.status).toBe(413);
	expect(await big.json()).toEqual({ error: "payload_too_large" });
	expect((await h.call("/api/queue/status")).status).toBe(200);
});

test("responses carry anti-framing security headers", async () => {
	const h = setup();
	for (const response of [
		await h.call("/api/status"),
		await h.call("/api/status", undefined, {}),
	]) {
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		expect(response.headers.get("x-frame-options")).toBe("DENY");
		expect(response.headers.get("content-security-policy")).toContain(
			"frame-ancestors 'none'",
		);
	}
});

test("requests with both Content-Length and Transfer-Encoding are rejected", async () => {
	const h = setup();
	const response = await h.app.request("/api/conversations", {
		method: "POST",
		headers: {
			...auth,
			"content-length": "10",
			"transfer-encoding": "chunked",
		},
		body: "{}",
	});
	expect(response.status).toBe(400);
	expect(await response.json()).toEqual({ error: "invalid_framing" });
});

test("error codes map to HTTP statuses through the table", async () => {
	const { statusForError } = await import("./error-status");
	expect(statusForError("request_conflict")).toBe(409);
	expect(statusForError("invalid_input")).toBe(400);
	expect(statusForError("env_ref_not_allowed")).toBe(400);
	expect(statusForError("payload_too_large")).toBe(413);
	expect(statusForError("queue_full")).toBe(503);
	expect(statusForError("something_unknown")).toBe(500);
});

test("Web research is authenticated, validates malformed JSON, and does not claim an unavailable cache was cleared", async () => {
	const h = setup();
	expect(
		(await h.app.request("/api/web-research/cache/clear", { method: "POST" }))
			.status,
	).toBe(401);
	expect(
		(
			await h.call(
				"/api/web-research/cache/clear",
				{},
				{ ...auth, origin: "https://foreign.example" },
			)
		).status,
	).toBe(403);
	const clear = await h.call("/api/web-research/cache/clear", {});
	expect(clear.status).toBe(503);
	expect(await clear.json()).toEqual({ error: "web_cache_unavailable" });
	expect(
		(
			await h.app.request("/api/web-research/runs", {
				method: "POST",
				headers: auth,
				body: "{",
			})
		).status,
	).toBe(400);
	expect((await h.call("/api/web-research/cache/status")).status).toBe(200);
});

test("modules mount in order behind the shared auth and origin checks", async () => {
	const app = createApp({
		token,
		origin: "http://127.0.0.1:5173",
		modules: [
			{ mount: (a) => void a.get("/api/probe", (c) => c.text("first")) },
			{ mount: (a) => void a.get("/api/probe", (c) => c.text("second")) },
		],
	});
	const response = await app.request("/api/probe", { headers: auth });
	expect(await response.text()).toBe("first");
	expect((await app.request("/api/probe")).status).toBe(401);
	const foreign = await app.request("/api/probe", {
		headers: { ...auth, origin: "http://evil.example" },
	});
	expect(foreign.status).toBe(403);
});

test("service-test concurrency limits cover the slow endpoints but not cancel or retry", async () => {
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const app = createApp({
		token,
		origin: "http://127.0.0.1:5173",
		modules: [
			{
				mount(a) {
					for (const path of [
						"/api/service-tests/runs",
						"/api/service-tests/diagnose",
						"/api/service-tests/uploads",
						"/api/service-tests/catalog/refresh",
					])
						a.post(path, async (c) => {
							await gate;
							return c.json({ ok: true });
						});
					a.post("/api/service-tests/runs/:id/cancel", (c) =>
						c.json({ ok: 1 }),
					);
					a.post("/api/service-tests/runs/:id/retry-artifact", (c) =>
						c.json({ ok: 1 }),
					);
				},
			},
		],
	});
	const post = (path: string) =>
		app.request(path, { method: "POST", headers: auth });
	const held = [
		post("/api/service-tests/runs"),
		post("/api/service-tests/diagnose"),
	];
	await new Promise((resolve) => setTimeout(resolve, 10));
	// The budget of 2 is shared by all slow endpoints.
	expect((await post("/api/service-tests/uploads")).status).toBe(429);
	expect((await post("/api/service-tests/catalog/refresh")).status).toBe(429);
	expect((await post("/api/service-tests/runs/r1/cancel")).status).toBe(200);
	expect((await post("/api/service-tests/runs/r1/retry-artifact")).status).toBe(
		200,
	);
	release();
	for (const response of await Promise.all(held))
		expect(response.status).toBe(200);
	expect((await post("/api/service-tests/uploads")).status).toBe(200);
});

test("CORS preflight allows every method the API serves", async () => {
	const app = createApp({
		token,
		origin: "http://127.0.0.1:5173",
		modules: [],
	});
	const response = await app.request("/api/anything", {
		method: "OPTIONS",
		headers: { origin: "http://127.0.0.1:5173" },
	});
	expect(response.status).toBe(204);
	expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
		"GET, POST, PUT, PATCH, DELETE, OPTIONS",
	);
});

test("stream-bounded upload routes skip the 1MiB JSON cap by exact path only", async () => {
	const app = createApp({
		token,
		origin: "http://127.0.0.1:5173",
		modules: [
			{
				mount: (a) => {
					a.post("/api/service-tests/uploads", (c) =>
						c.json({ ok: true }, 201),
					);
					a.post("/api/service-tests/uploads/x", (c) =>
						c.json({ ok: true }, 201),
					);
					a.post("/api/runs", (c) => c.json({ ok: true }, 201));
				},
			},
		],
	});
	const post = (path: string) =>
		app.request(path, {
			method: "POST",
			headers: { ...auth, "content-length": "2000000" },
			body: "{}",
		});
	expect((await post("/api/service-tests/uploads")).status).toBe(201);
	expect((await post("/api/runs")).status).toBe(413);
	expect((await post("/api/service-tests/uploads/x")).status).toBe(413);
});

test("malformed percent-encoding in a path parameter does not return 500", async () => {
	const app = createApp({
		token,
		origin: "http://127.0.0.1:5173",
		modules: [
			{
				mount: (a) => {
					a.get("/api/test/:id", (c) => c.json({ id: c.req.param("id") }));
				},
			},
		],
	});
	const response = await app.request("/api/test/%E0%A4%A", { headers: auth });
	expect(response.status).not.toBe(500);
});

test("API responses carry a deny-all Content-Security-Policy", async () => {
	const h = setup();
	const response = await h.call("/api/status");
	expect(response.headers.get("content-security-policy")).toContain(
		"default-src 'none'",
	);
});
