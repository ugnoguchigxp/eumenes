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
		name: "runErrorReport",
		call: (c) => c.runErrorReport("r/1"),
		method: "GET",
		path: "/api/runs/r%2F1/error-report",
		response: { runId: "r1", text: "# Eumenes エラーレポート" },
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
	evidence: [],
	validity: null,
	capturedBy: "manual",
};
const continuityNote = {
	id: "n1",
	conversationId: "main",
	kind: "activity",
	text: "Rust移行の調査",
	status: "active",
	revision: 2,
	createdAt: "2026-10-13T00:00:00.000Z",
	updatedAt: "2026-10-13T01:00:00.000Z",
	origin: "agent",
	sourceMessageIds: ["m1"],
	expiresAt: "2026-10-27T01:00:00.000Z",
};
const tendency = {
	id: "t1",
	text: "朝型",
	revision: 1,
	updatedAt: "2026-10-13T01:00:00.000Z",
};
const memoryContext = {
	version: 3,
	longTerm: { text: "以下は…", bytes: 9, limit: 16384 },
	shortTerm: { text: "", bytes: 0, limit: 8192, pendingAdditions: 0 },
	notices: 1,
};
const decision = {
	id: 7,
	conversationId: "main",
	jobId: "j1",
	step: "curate-memory",
	createdAt: "2026-10-14T00:00:00.000Z",
	output: { remember: [] },
	results: [{ status: "applied" }],
	windowVersionBefore: 2,
	windowVersionAfter: 3,
	durationMs: 1200,
	outputTokens: 80,
	errorCode: null,
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
		name: "memoryShortTerm",
		call: (c) => c.memoryShortTerm("main/1"),
		method: "GET",
		path: "/api/memory/short-term?conversationId=main%2F1",
		response: { items: [continuityNote] },
		result: [continuityNote],
	},
	{
		name: "memoryTendencies",
		call: (c) => c.memoryTendencies(),
		method: "GET",
		path: "/api/memory/tendencies",
		response: { items: [tendency] },
		result: [tendency],
	},
	{
		name: "memoryContext",
		call: (c) => c.memoryContext("main"),
		method: "GET",
		path: "/api/memory/context?conversationId=main",
		response: memoryContext,
	},
	{
		name: "stewardDecisions",
		call: (c) => c.stewardDecisions("main/1", 20),
		method: "GET",
		path: "/api/steward/decisions?conversationId=main%2F1&limit=20",
		response: { items: [decision] },
		result: [decision],
	},
	{
		name: "memoryContext (off)",
		call: (c) => c.memoryContext("main"),
		method: "GET",
		path: "/api/memory/context?conversationId=main",
		response: { disabled: true },
		parsed: false,
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
	observation: {
		turnOutcome: "unconfirmed",
		terminalEventSeq: null,
		processStarted: true,
		captureState: "complete",
		captureIssues: [],
	},
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

const attitudeStatus = {
	enabled: true,
	target: 300,
	successful: 2,
	unreviewed: 1,
	reviewed: 1,
	held: 0,
	skipped: 0,
	skip_reasons: {},
	pending: 0,
	failed: 0,
	storage_errors: 0,
	score_notice: "provisional",
};
const attitudeReport = {
	...attitudeStatus,
	contrasting_context_groups: [{ sample_ids: ["s1"], reviewed: 1 }],
	short_texts: 0,
	dominant_class_fraction: null,
	classes: { joy: 1 },
	rejections: {},
	coverage: { short: 0 },
	missing_classes: [],
	missing_coverage: [],
	differences: [],
	granularity: { answer: 1, chunk: 1 },
	splits: { train: 0, calibration: 0, eval: 0 },
	warnings: [],
};
const attitudeSample = {
	sample_id: "s1",
	conversation_id: "c1",
	revision: 0,
	primary_label: null,
	acceptable_labels: [],
	expression_transition: null,
	review_status: "unreviewed",
	correction_reason: null,
	template_group_id: "g1",
	template_group_confirmed: false,
	coverage_tags: [],
	current_chunk: "こんにちは",
	split: null,
};
contracts("attitude-dataset client", [
	{
		name: "attitudeStatus",
		call: (c) => c.attitudeStatus(),
		method: "GET",
		path: "/api/attitude-dataset/status",
		response: attitudeStatus,
	},
	{
		name: "attitudeStart",
		call: (c) => c.attitudeStart(),
		method: "POST",
		path: "/api/attitude-dataset/start",
		body: {},
		response: attitudeStatus,
	},
	{
		name: "attitudeStop",
		call: (c) => c.attitudeStop(),
		method: "POST",
		path: "/api/attitude-dataset/stop",
		body: {},
		response: attitudeStatus,
	},
	{
		name: "attitudeSamples",
		call: (c) => c.attitudeSamples(),
		method: "GET",
		path: "/api/attitude-dataset/samples",
		response: [
			{
				sample_id: "s1",
				review_status: "unreviewed",
				revision: 0,
				granularity: "chunk",
				chunk_order: 1,
			},
		],
	},
	{
		name: "attitudeSample",
		call: (c) => c.attitudeSample("s/1", true),
		method: "GET",
		path: "/api/attitude-dataset/samples/s%2F1?predictions=show",
		response: attitudeSample,
	},
	{
		name: "attitudeReview",
		call: (c) => c.attitudeReview("s1", { label: "ok" }),
		method: "POST",
		path: "/api/attitude-dataset/samples/s1/review",
		body: { label: "ok" },
		response: { sample_id: "s1", revision: 1, review_status: "reviewed" },
	},
	{
		name: "attitudeReport",
		call: (c) => c.attitudeReport(),
		method: "GET",
		path: "/api/attitude-dataset/report",
		response: attitudeReport,
	},
	{
		name: "attitudeSplit",
		call: (c) => c.attitudeSplit(),
		method: "POST",
		path: "/api/attitude-dataset/split",
		body: {},
		response: {
			counts: { train: 1, calibration: 0, eval: 0 },
			groups: 1,
			warning: null,
		},
	},
	{
		name: "attitudeExport",
		call: (c) => c.attitudeExport(),
		method: "GET",
		path: "/api/attitude-dataset/export",
		response: {
			jsonl: "",
			partitions: { train: "", calibration: "", eval: "" },
			report: attitudeReport,
			schema: { title: "sample" },
		},
	},
]);

const researchRun = {
	id: "rr1",
	requestId: "q1",
	jobId: "j1",
	operation: "lookup",
	status: "queued",
	createdAt: t0,
	finishedAt: null,
	errorCode: null,
	result: null,
	resultExpired: false,
};
contracts("web-research client", [
	{
		name: "submitResearch",
		call: (c) => c.submitResearch({ requestId: "q1", query: "bun" } as never),
		method: "POST",
		path: "/api/web-research/runs",
		body: { requestId: "q1", query: "bun" },
		response: researchRun,
	},
	{
		name: "researchRun",
		call: (c) => c.researchRun("rr/1"),
		method: "GET",
		path: "/api/web-research/runs/rr%2F1",
		response: researchRun,
	},
	{
		name: "cancelResearch",
		call: (c) => c.cancelResearch("rr1"),
		method: "POST",
		path: "/api/web-research/runs/rr1/cancel",
		body: {},
		response: researchRun,
	},
	{
		name: "researchCacheStatus",
		call: (c) => c.researchCacheStatus(),
		method: "GET",
		path: "/api/web-research/cache/status",
		response: {
			enabled: true,
			entries: 0,
			bytes: 0,
			generation: 1,
			lastSweepAt: null,
		},
	},
	{
		name: "clearResearchCache",
		call: (c) => c.clearResearchCache(),
		method: "POST",
		path: "/api/web-research/cache/clear",
		body: {},
		response: { cleared: true },
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
