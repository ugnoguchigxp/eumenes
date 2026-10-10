import { describe, expect, it } from "vitest";
import { contracts, newClient, stubFetch } from "./harness";

const t0 = "2026-10-10T00:00:00.000Z";
const uuid = "11111111-1111-4111-8111-111111111111";
const uuid2 = "22222222-2222-4222-8222-222222222222";
const uuid3 = "33333333-3333-4333-8333-333333333333";

const timer = {
	id: uuid,
	revision: 1,
	state: "active",
	label: "tea",
	durationSeconds: 180,
	startedAt: t0,
	dueAt: "2026-10-10T00:03:00.000Z",
	cancelledAt: null,
	remainingSeconds: 180,
	conversationId: null,
	originRunId: null,
	originMessageId: null,
	errorCode: null,
	bodyExpired: false,
};
const notification = {
	id: uuid2,
	timerId: uuid,
	generation: 1,
	revision: 1,
	status: "pending",
	reason: null,
	dueAt: "2026-10-10T00:03:00.000Z",
	message: "tea is ready",
};
const receipt = {
	kind: "timer_action",
	action: "started",
	operationId: uuid3,
	serverNow: t0,
	timer,
	artifact: { kind: "timer", version: 1, timerId: uuid },
};
const claim = {
	serverNow: t0,
	notification: { ...notification, status: "claimed" },
	claimId: uuid3,
	leaseUntil: "2026-10-10T00:00:30.000Z",
};
contracts("timers client", [
	{
		name: "startTimer",
		call: (c) =>
			c.startTimer({ requestId: uuid, issuedAt: t0, durationSeconds: 180 }),
		method: "POST",
		path: "/api/timers",
		body: { requestId: uuid, issuedAt: t0, durationSeconds: 180 },
		response: receipt,
	},
	{
		name: "timers",
		call: (c) => c.timers({ state: "active", limit: 3 }),
		method: "GET",
		path: "/api/timers?state=active&limit=3",
		response: { serverNow: t0, items: [timer], nextCursor: null },
	},
	{
		name: "timer",
		call: (c) => c.timer(uuid),
		method: "GET",
		path: `/api/timers/${uuid}`,
		response: { serverNow: t0, timer, notification: null },
	},
	{
		name: "timerReceiptByRun",
		call: (c) => c.timerReceiptByRun("run/1"),
		method: "GET",
		path: "/api/timer-actions/by-run/run%2F1",
		response: { serverNow: t0, receipt: null },
	},
	{
		name: "cancelTimer",
		call: (c) =>
			c.cancelTimer(uuid, {
				requestId: uuid2,
				issuedAt: t0,
				expectedRevision: 1,
			}),
		method: "POST",
		path: `/api/timers/${uuid}/cancel`,
		body: { requestId: uuid2, issuedAt: t0, expectedRevision: 1 },
		response: {
			kind: "timer_action",
			action: "cancelled",
			operationId: uuid3,
			serverNow: t0,
			timer: { ...timer, state: "cancelled", cancelledAt: t0 },
		},
	},
	{
		name: "timerNotifications",
		call: (c) => c.timerNotifications({ cursor: "c1", limit: 4 }),
		method: "GET",
		path: "/api/timer-notifications?cursor=c1&limit=4",
		response: {
			serverNow: t0,
			activeTimers: 1,
			items: [notification],
			nextCursor: null,
		},
	},
	{
		name: "claimTimerNotification",
		call: (c) =>
			c.claimTimerNotification(uuid2, {
				clientId: uuid,
				claimRequestId: uuid3,
				expectedRevision: 1,
			}),
		method: "POST",
		path: `/api/timer-notifications/${uuid2}/claim`,
		body: { clientId: uuid, claimRequestId: uuid3, expectedRevision: 1 },
		response: claim,
	},
	{
		name: "ackTimerNotification",
		call: (c) =>
			c.ackTimerNotification(uuid2, {
				clientId: uuid,
				claimId: uuid3,
				outcome: "played",
			}),
		method: "POST",
		path: `/api/timer-notifications/${uuid2}/ack`,
		body: { clientId: uuid, claimId: uuid3, outcome: "played" },
		response: claim,
	},
	{
		name: "silenceTimerNotification",
		call: (c) =>
			c.silenceTimerNotification(uuid2, {
				expectedRevision: 1,
				reason: "muted",
			}),
		method: "POST",
		path: `/api/timer-notifications/${uuid2}/silence`,
		body: { expectedRevision: 1, reason: "muted" },
		response: { serverNow: t0, notification },
	},
]);

const row = {
	id: "cl1",
	revision: 1,
	target: { subjectId: "s1" },
	claim: {
		predicate: "likes",
		content: { kind: "value", value: { kind: "string", value: "tea" } },
	},
	adoption: "adopted",
	origin: "user_report",
	evidenceKinds: ["user_statement"],
	freshness: "fresh",
	tone: "adopted",
};
const scope = { scopeKey: "profile:owner" };
const forget = {
	forgetId: "f1",
	display: "pending",
	state: "requested",
	blocked: null,
	abandoned: { parts: 0, roots: 0 },
	origin: "user",
	rootCount: 1,
	createdAt: 1,
	updatedAt: 1,
};
const target = { claimId: "cl1" };
contracts("world client", [
	{
		name: "worldStatus",
		call: (c) => c.worldStatus(),
		method: "GET",
		path: "/api/world/status",
		response: {
			mode: "on",
			enabled: true,
			usable: true,
			gateOpen: true,
			scopes: [scope],
		},
	},
	{
		name: "worldClaims",
		call: (c) => c.worldClaims("profile:owner"),
		method: "GET",
		path: "/api/world/claims?scopeKey=profile%3Aowner",
		response: {
			scopeKey: "profile:owner",
			scopes: [scope],
			asOf: 1,
			complete: true,
			stopped: 0,
			items: [row],
		},
	},
	{
		name: "worldClaim",
		call: (c) => c.worldClaim("cl/1"),
		method: "GET",
		path: "/api/world/claims/cl%2F1",
		response: {
			claim: row,
			scopeKey: "profile:owner",
			asOf: 1,
			recordedAt: 1,
			condition: {
				kind: "unspecified",
				text: "",
				evaluation: "unknown",
				reasons: [],
			},
			supports: [],
			refutations: { evidence: [], claims: [] },
			sources: [],
			history: [],
			historyTruncated: false,
		},
	},
	{
		name: "worldForgets",
		call: (c) => c.worldForgets(),
		method: "GET",
		path: "/api/world/forgets",
		response: { scopeKey: "profile:owner", forgets: [forget] },
	},
	{
		name: "correctWorldClaim",
		call: (c) =>
			c.correctWorldClaim({
				requestId: uuid,
				expectedRevision: 1,
				target,
				reasonMessageId: "m1",
				value: { kind: "string", value: "coffee" },
			}),
		method: "POST",
		path: "/api/world/claims/correct",
		body: {
			requestId: uuid,
			expectedRevision: 1,
			target,
			reasonMessageId: "m1",
			value: { kind: "string", value: "coffee" },
		},
		response: { status: "applied", claimId: "cl2" },
	},
	{
		name: "retractWorldClaim",
		call: (c) =>
			c.retractWorldClaim({
				requestId: uuid,
				expectedRevision: 1,
				target,
				reasonMessageId: "m1",
			}),
		method: "POST",
		path: "/api/world/claims/retract",
		body: {
			requestId: uuid,
			expectedRevision: 1,
			target,
			reasonMessageId: "m1",
		},
		response: { status: "unresolved", candidates: [row] },
	},
	{
		name: "forgetWorldClaim",
		call: (c) =>
			c.forgetWorldClaim({ requestId: uuid, expectedRevision: 1, target }),
		method: "POST",
		path: "/api/world/claims/forget",
		body: { requestId: uuid, expectedRevision: 1, target },
		response: { status: "accepted", forget },
	},
]);

const source = {
	sourceId: "s1",
	url: "https://example.com/a",
	title: "A",
	basis: "page",
	fetchedAt: t0,
	truncated: false,
};
const agentTask = {
	id: "at1",
	kind: "coordinator",
	rootRunId: "r1",
	parentTaskId: null,
	packageRevisionId: null,
	status: "running",
	phase: "plan",
	modelCalls: 1,
	toolCalls: 0,
	errorCode: null,
	createdAt: t0,
	deadlineAt: t0,
	reportState: "none",
};
contracts("agent-runtime client", [
	{
		name: "capabilities",
		call: (c) => c.capabilities(),
		method: "GET",
		path: "/api/capabilities",
		response: {
			items: [{ id: "web.research", title: "Web", summary: "search" }],
			nextCursor: null,
		},
	},
	{
		name: "agentTasks",
		call: (c) => c.agentTasks("r/1"),
		method: "GET",
		path: "/api/agent-tasks?rootRunId=r%2F1",
		response: [agentTask],
	},
	{
		name: "agentTask",
		call: (c) => c.agentTask("at1"),
		method: "GET",
		path: "/api/agent-tasks/at1",
		response: agentTask,
	},
	{
		name: "agentReport",
		call: (c) => c.agentReport("at1"),
		method: "GET",
		path: "/api/agent-tasks/at1/report",
		response: {
			summary: "done",
			claims: [{ text: "c", evidence: [{ sourceId: "s1", quote: "q" }] }],
			limitations: [],
			coverage: "complete",
			verification: "evidence_linked",
			sources: [source],
		},
	},
	{
		name: "cancelAgentTask",
		call: (c) => c.cancelAgentTask("at1"),
		method: "POST",
		path: "/api/agent-tasks/at1/cancel",
		body: {},
		response: { ...agentTask, status: "cancelled" },
	},
]);

contracts("coding-supervision client (supervisor)", [
	{
		name: "taskSupervisor",
		call: (c) => c.taskSupervisor("task1"),
		method: "GET",
		path: "/api/tasks/task1/supervisor",
		response: {
			diagnosticDue: false,
			taskId: "task1",
			generation: 1,
			authorityEpoch: 1,
			lastObservedAt: null,
			lastProgressAt: null,
			nextCheckAt: 1,
			monitorHealth: "healthy",
			failures: 0,
			fingerprint: null,
			handledFingerprint: null,
			decisionId: null,
			stepId: null,
			decisionsUsed: 0,
			repairLoops: 0,
			lastReportAt: null,
			lastReportFingerprint: null,
			holdReason: null,
			pendingApproval: null,
		},
	},
	{
		name: "taskSupervisor (no supervisor)",
		call: (c) => c.taskSupervisor("task1"),
		method: "GET",
		path: "/api/tasks/task1/supervisor",
		response: null,
		parsed: false,
	},
]);

const turn = {
	utteranceId: uuid,
	sessionId: uuid2,
	generation: 1,
	sequence: 1,
	status: "ready",
	text: "hello",
	runId: null,
	error: null,
	revision: 1,
};
const wav = new Uint8Array([1, 2, 3]);
contracts("voice-dialogue client", [
	{
		name: "voiceStart",
		call: (c) => c.voiceStart(uuid2, 1),
		method: "POST",
		path: "/api/voice/sessions",
		body: { sessionId: uuid2, generation: 1 },
		response: { ok: true },
		parsed: false,
	},
	{
		name: "voiceStop",
		call: (c) => c.voiceStop(uuid2, 1),
		method: "POST",
		path: "/api/voice/sessions/stop",
		body: { sessionId: uuid2, generation: 1 },
		response: { ok: true },
		parsed: false,
	},
	{
		name: "voiceSend",
		call: (c) => c.voiceSend(uuid2, 1, 1, uuid, wav),
		method: "POST",
		path: "/api/voice/turns",
		response: turn,
	},
	{
		name: "voicePreview",
		call: (c) =>
			c.voicePreview(uuid2, 1, uuid, wav, new AbortController().signal),
		method: "POST",
		path: "/api/voice/preview",
		response: { utteranceId: uuid, text: "hel" },
	},
	{
		name: "voiceTurn",
		call: (c) => c.voiceTurn("u/1"),
		method: "GET",
		path: "/api/voice/turns/u%2F1",
		response: turn,
	},
	{
		name: "voicePlayed",
		call: (c) => c.voicePlayed(uuid, 2),
		method: "POST",
		path: `/api/voice/turns/${uuid}/played?index=2`,
		body: {},
		response: { ...turn, status: "played" },
	},
	{
		name: "replaySentences",
		call: (c) => c.replaySentences("a. b."),
		method: "POST",
		path: "/api/voice/replay/sentences",
		body: { text: "a. b." },
		response: { sentences: ["a.", "b."] },
		result: ["a.", "b."],
	},
	{
		name: "voiceCancel",
		call: (c) => c.voiceCancel(uuid),
		method: "POST",
		path: `/api/voice/turns/${uuid}/cancel`,
		body: {},
		response: { ...turn, status: "cancelled" },
	},
]);

describe("voice-dialogue binary endpoints", () => {
	const audio = () =>
		new Response(new Uint8Array([9, 8, 7]), {
			headers: { "Content-Type": "audio/wav", "X-Avatar-Motion": "joyful" },
		});
	it("voiceAudio returns the bytes of the requested chunk", async () => {
		const seen = stubFetch(audio);
		expect(await newClient().voiceAudio("u1", 3)).toEqual(
			new Uint8Array([9, 8, 7]),
		);
		expect(seen[0]?.path).toBe("/api/voice/turns/u1/audio?index=3");
	});
	it("replayAudio and voiceSample post JSON and return bytes", async () => {
		const seen = stubFetch(audio);
		const client = newClient();
		expect(await client.replayAudio("hi")).toEqual(new Uint8Array([9, 8, 7]));
		expect(await client.voiceSample({ voice: "v1", speed: 1.2 })).toEqual(
			new Uint8Array([9, 8, 7]),
		);
		expect(seen.map((s) => [s.method, s.path, s.body])).toEqual([
			["POST", "/api/voice/replay/audio", { text: "hi" }],
			["POST", "/api/voice/sample", { voice: "v1", speed: 1.2 }],
		]);
	});
	it("replaySpeech reads the avatar motion header and falls back to neutral", async () => {
		const seen = stubFetch(audio);
		const spoken = await newClient().replaySpeech("hi", undefined, "run-1");
		expect(spoken).toEqual({
			wav: new Uint8Array([9, 8, 7]),
			motion: "joyful",
		});
		expect(seen[0]?.body).toEqual({ text: "hi", runId: "run-1" });
		stubFetch(
			() =>
				new Response(new Uint8Array([1]), {
					headers: { "X-Avatar-Motion": "bogus" },
				}),
		);
		expect((await newClient().replaySpeech("hi")).motion).toBe("neutral");
	});
	it("surfaces a 4xx {error} as ApiError", async () => {
		stubFetch(() =>
			Response.json({ error: "voice_stale_session" }, { status: 409 }),
		);
		await expect(newClient().voiceAudio("u1")).rejects.toMatchObject({
			status: 409,
			message: "voice_stale_session",
		});
		await expect(newClient().replayAudio("hi")).rejects.toMatchObject({
			message: "voice_stale_session",
		});
	});
});

describe("dialogue watchRun", () => {
	const sse = (...frames: unknown[]) =>
		new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""), {
			headers: { "Content-Type": "text/event-stream" },
		});
	const progress = (status: string, text = "") => ({
		runId: "r1",
		status,
		text,
	});
	it("delivers parsed progress until a terminal status", async () => {
		const seen = stubFetch(() =>
			sse(progress("running", "he"), progress("completed", "hello")),
		);
		const values: unknown[] = [];
		await newClient().watchRun("r1", new AbortController().signal, (v) =>
			values.push(v),
		);
		expect(values).toEqual([
			progress("running", "he"),
			progress("completed", "hello"),
		]);
		expect(seen[0]?.path).toBe("/api/runs/r1/stream");
		expect(seen[0]?.headers.accept).toBe("text/event-stream");
	});
	it("rejects a frame that violates the schema", async () => {
		stubFetch(() => sse({ runId: "r1", status: "nonsense", text: "" }));
		await expect(
			newClient().watchRun("r1", new AbortController().signal, () => {}),
		).rejects.toMatchObject({ name: "ZodError" });
	});
	it("rejects a stream of another run and a non-stream answer", async () => {
		stubFetch(() => sse({ runId: "other", status: "running", text: "" }));
		await expect(
			newClient().watchRun("r1", new AbortController().signal, () => {}),
		).rejects.toThrow("run_stream_mismatch");
		stubFetch(() => Response.json({}));
		await expect(
			newClient().watchRun("r1", new AbortController().signal, () => {}),
		).rejects.toThrow("invalid_run_stream");
	});
	it("surfaces a 4xx {error} as ApiError", async () => {
		stubFetch(() => Response.json({ error: "not_found" }, { status: 404 }));
		await expect(
			newClient().watchRun("r1", new AbortController().signal, () => {}),
		).rejects.toMatchObject({ status: 404, message: "not_found" });
	});
});
