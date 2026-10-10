import { describe, expect, it } from "vitest";
import { contracts, newClient, stubFetch } from "./harness";

const t0 = "2026-10-10T00:00:00.000Z";

const message = {
	id: "m1",
	conversationId: "c1",
	role: "user",
	text: "hello",
	createdAt: t0,
	runId: null,
};
contracts("conversation client", [
	{
		name: "conversation",
		call: (c) => c.conversation("c/1"),
		method: "GET",
		path: "/api/conversations/c%2F1",
		response: { id: "c1", revision: 1, messages: [message] },
	},
]);

const run = {
	id: "r1",
	requestId: "q1",
	conversationId: "c1",
	utteranceId: null,
	status: "queued",
	revision: 1,
	inputMessageId: "m1",
	answerMessageId: null,
	error: null,
	jobId: null,
	deadlineAt: null,
	sourceKind: "manual",
	scheduleId: null,
	occurrenceId: null,
	createdAt: t0,
	updatedAt: t0,
};
contracts("dialogue client", [
	{
		name: "runs",
		call: (c) => c.runs("c1"),
		method: "GET",
		path: "/api/conversations/c1/runs",
		response: [run],
	},
	{
		name: "submit",
		call: (c) =>
			c.submit({
				requestId: "11111111-1111-4111-8111-111111111111",
				conversationId: "c1",
				text: "hi",
			}),
		method: "POST",
		path: "/api/runs",
		body: {
			requestId: "11111111-1111-4111-8111-111111111111",
			conversationId: "c1",
			text: "hi",
		},
		response: run,
	},
	{
		name: "run",
		call: (c) => c.run("r1"),
		method: "GET",
		path: "/api/runs/r1",
		response: run,
	},
	{
		name: "cancel",
		call: (c) => c.cancel("r1"),
		method: "POST",
		path: "/api/runs/r1/cancel",
		body: {},
		response: { ...run, status: "cancelled" },
	},
]);

const larmStatus = {
	service: "larm",
	larm: { state: "ready", capabilities: ["llm", "tts"] },
};
contracts("larm client", [
	{
		name: "status",
		call: (c) => c.status(),
		method: "GET",
		path: "/api/status",
		response: larmStatus,
	},
	{
		name: "connectLarm",
		call: (c) => c.connectLarm(),
		method: "POST",
		path: "/api/larm/connect",
		response: larmStatus,
	},
]);

const memoryItem = {
	id: "mem1",
	kind: "preference",
	semanticKey: "drink",
	text: "likes tea",
	polarity: "affirmed",
	status: "active",
	origin: "user",
	revision: 1,
	sourceMessageIds: ["m1"],
	validFromMs: null,
	validUntilMs: null,
};
contracts("memory client", [
	{
		name: "memoryStatus",
		call: (c) => c.memoryStatus(),
		method: "GET",
		path: "/api/memory/status",
		response: { enabled: true, healthy: true },
	},
	{
		name: "setMemoryEnabled",
		call: (c) => c.setMemoryEnabled(false),
		method: "POST",
		path: "/api/memory/settings",
		body: { enabled: false },
		response: { enabled: false, healthy: true },
	},
	{
		name: "memoryItems",
		call: (c) => c.memoryItems(true),
		method: "GET",
		path: "/api/memory/items?all=1",
		response: { items: [memoryItem] },
		result: [memoryItem],
	},
	{
		name: "rememberItem",
		call: (c) =>
			c.rememberItem({
				conversationId: "c1",
				messageId: "m1",
				quote: "tea",
				kind: "preference",
				semanticKey: "drink",
				text: "likes tea",
			}),
		method: "POST",
		path: "/api/memory/items",
		body: {
			conversationId: "c1",
			messageId: "m1",
			quote: "tea",
			kind: "preference",
			semanticKey: "drink",
			text: "likes tea",
		},
		response: memoryItem,
	},
	{
		name: "memoryAction",
		call: (c) => c.memoryAction("mem/1", "stop", 3),
		method: "POST",
		path: "/api/memory/items/mem%2F1/stop",
		body: { expectedRevision: 3 },
		response: { ...memoryItem, status: "stopped", revision: 4 },
	},
	{
		name: "forgetItem",
		call: (c) => c.forgetItem("mem1"),
		method: "POST",
		path: "/api/memory/items/mem1/forget",
		body: {},
		response: { forgetId: "f1", completed: true },
	},
]);

const entry = { written: "NASA", spoken: "ナサ" };
const dictionaryAnswer = { entries: [entry] };
contracts("tts-dictionary client", [
	{
		name: "ttsDictionary",
		call: (c) => c.ttsDictionary(),
		method: "GET",
		path: "/api/tts-dictionary",
		response: dictionaryAnswer,
		result: [entry],
	},
	{
		name: "saveTtsDictionaryEntry",
		call: (c) =>
			c.saveTtsDictionaryEntry({
				original: null,
				entry,
				expected: { spoken: null },
			}),
		method: "POST",
		path: "/api/tts-dictionary/save",
		body: { original: null, entry, expected: { spoken: null } },
		response: dictionaryAnswer,
		result: [entry],
	},
	{
		name: "deleteTtsDictionaryEntry",
		call: (c) =>
			c.deleteTtsDictionaryEntry({
				written: "NASA",
				expected: { spoken: "ナサ" },
			}),
		method: "POST",
		path: "/api/tts-dictionary/delete",
		body: { written: "NASA", expected: { spoken: "ナサ" } },
		response: { entries: [] },
		result: [],
	},
]);

const execution = {
	id: "e1",
	taskId: "t1",
	generation: 1,
	authorityEpoch: 1,
	state: "running",
	cursor: 0,
	turnFinished: false,
	childrenStopped: false,
	evidenceComplete: false,
	reason: null,
	exitCode: null,
	createdAt: t0,
	updatedAt: t0,
};
contracts("coding client", [
	{
		name: "codingWorkspaces",
		call: (c) => c.codingWorkspaces(),
		method: "GET",
		path: "/api/coding/workspaces",
		response: {
			items: [{ id: "w1", branch: "main", available: true, reason: null }],
		},
	},
	{
		name: "codingExecution",
		call: (c) => c.codingExecution("e/1"),
		method: "GET",
		path: "/api/coding/executions/e%2F1",
		response: execution,
	},
	{
		name: "codingExecutionEvents",
		call: (c) => c.codingExecutionEvents("e1", 4, 10),
		method: "GET",
		path: "/api/coding/executions/e1/events?after=4&limit=10",
		response: { execution, events: [] },
	},
]);

// These endpoints hand the backend JSON through without a zod parse.
const passthrough = { ok: true };
contracts("attitude-dataset client", [
	{
		name: "attitudeStatus",
		call: (c) => c.attitudeStatus(),
		method: "GET",
		path: "/api/attitude-dataset/status",
		response: passthrough,
		parsed: false,
	},
	{
		name: "attitudeStart",
		call: (c) => c.attitudeStart(),
		method: "POST",
		path: "/api/attitude-dataset/start",
		body: {},
		response: passthrough,
		parsed: false,
	},
	{
		name: "attitudeStop",
		call: (c) => c.attitudeStop(),
		method: "POST",
		path: "/api/attitude-dataset/stop",
		body: {},
		response: passthrough,
		parsed: false,
	},
	{
		name: "attitudeSamples",
		call: (c) => c.attitudeSamples(),
		method: "GET",
		path: "/api/attitude-dataset/samples",
		response: passthrough,
		parsed: false,
	},
	{
		name: "attitudeSample",
		call: (c) => c.attitudeSample("s/1", true),
		method: "GET",
		path: "/api/attitude-dataset/samples/s%2F1?predictions=show",
		response: passthrough,
		parsed: false,
	},
	{
		name: "attitudeReview",
		call: (c) => c.attitudeReview("s1", { label: "ok" }),
		method: "POST",
		path: "/api/attitude-dataset/samples/s1/review",
		body: { label: "ok" },
		response: passthrough,
		parsed: false,
	},
	{
		name: "attitudeReport",
		call: (c) => c.attitudeReport(),
		method: "GET",
		path: "/api/attitude-dataset/report",
		response: passthrough,
		parsed: false,
	},
	{
		name: "attitudeSplit",
		call: (c) => c.attitudeSplit(),
		method: "POST",
		path: "/api/attitude-dataset/split",
		body: {},
		response: passthrough,
		parsed: false,
	},
	{
		name: "attitudeExport",
		call: (c) => c.attitudeExport(),
		method: "GET",
		path: "/api/attitude-dataset/export",
		response: passthrough,
		parsed: false,
	},
]);

const researchRun = { id: "rr1", status: "queued" };
contracts("web-research client", [
	{
		name: "submitResearch",
		call: (c) => c.submitResearch({ requestId: "q1", query: "bun" } as never),
		method: "POST",
		path: "/api/web-research/runs",
		body: { requestId: "q1", query: "bun" },
		response: researchRun,
		parsed: false,
	},
	{
		name: "researchRun",
		call: (c) => c.researchRun("rr/1"),
		method: "GET",
		path: "/api/web-research/runs/rr%2F1",
		response: researchRun,
		parsed: false,
	},
	{
		name: "cancelResearch",
		call: (c) => c.cancelResearch("rr1"),
		method: "POST",
		path: "/api/web-research/runs/rr1/cancel",
		body: {},
		response: researchRun,
		parsed: false,
	},
	{
		name: "researchCacheStatus",
		call: (c) => c.researchCacheStatus(),
		method: "GET",
		path: "/api/web-research/cache/status",
		response: { entries: 0 },
		parsed: false,
	},
	{
		name: "clearResearchCache",
		call: (c) => c.clearResearchCache(),
		method: "POST",
		path: "/api/web-research/cache/clear",
		body: {},
		response: { cleared: true },
		parsed: false,
	},
]);

describe("transport", () => {
	it("falls back to the HTTP status when a failure body is not JSON", async () => {
		stubFetch(() => new Response("<html>", { status: 502 }));
		await expect(newClient().status()).rejects.toMatchObject({
			status: 502,
			message: "HTTP 502",
		});
	});
});
