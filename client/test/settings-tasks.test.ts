import { describe, expect, it } from "vitest";
import { contracts, newClient, stubFetch } from "./harness";

const t0 = "2026-10-10T00:00:00.000Z";
const uuid = "11111111-1111-4111-8111-111111111111";
const uuid2 = "22222222-2222-4222-8222-222222222222";

const route = {
	mode: "larm-preferred",
	cloudAllowed: false,
	fallbackId: null,
	epoch: 0,
};
const settings = {
	revision: 1,
	codingSupervision: { approveInstructions: true },
	larm: {
		baseUrl: "http://127.0.0.1:9000",
		profile: "default",
		audience: "same-host",
		voice: "v1",
	},
	connections: [],
	resources: [],
	routes: { llm: route, asr: route, tts: route },
	voice: {
		autoSpeak: true,
		outputVolume: 1,
		bargeIn: false,
		inputDevice: "",
		outputDevice: "",
		threshold: 0.01,
		silenceMs: 800,
		echoCancellation: true,
		noiseSuppression: true,
		autoGainControl: true,
	},
	general: {
		agentName: "",
		userName: "",
		persona: "butler",
		asrLanguages: ["ja"],
		theme: "system",
		subtitles: { enabled: false, style: "netflix", size: "large" },
	},
};
const voices = {
	model: "tts-1",
	voices: [{ id: "v1", display_name: "V1", styles: [], capabilities: {} }],
};
const usage = {
	id: "u1",
	requestId: "q1",
	subject: "run:r1",
	purpose: "llm",
	source: "larm",
	model: "m",
	status: "ok",
	reason: null,
	started: 1,
	ended: 2,
	accepted: 1,
	inputTokens: 10,
	outputTokens: 5,
};
const probe = {
	id: "p1",
	target: "llm",
	status: "running",
	error: null,
	revision: 1,
	created: 1,
};
contracts("settings client", [
	{
		name: "larmVoices",
		call: (c) => c.larmVoices(),
		method: "GET",
		path: "/api/inference/voices",
		response: voices,
	},
	{
		name: "settings",
		call: (c) => c.settings(),
		method: "GET",
		path: "/api/settings",
		response: settings,
	},
	{
		name: "applySettings",
		call: (c) =>
			c.applySettings({
				requestId: uuid,
				expectedRevision: 1,
				settings,
				keys: [],
			} as never),
		method: "POST",
		path: "/api/settings/apply",
		body: { requestId: uuid, expectedRevision: 1, settings, keys: [] },
		response: { ...settings, revision: 2 },
	},
	{
		name: "settingsDiagnostics",
		call: (c) => c.settingsDiagnostics(),
		method: "GET",
		path: "/api/settings/diagnostics",
		response: {
			keyError: null,
			connections: [{ id: uuid, credentialAvailable: true, source: "stored" }],
		},
	},
	{
		name: "inferenceUsage",
		call: (c) => c.inferenceUsage(),
		method: "GET",
		path: "/api/inference/usage",
		response: [usage],
	},
	{
		name: "larmDetails",
		call: (c) => c.larmDetails(),
		method: "GET",
		path: "/api/inference/larm",
		response: {
			profile: "default",
			providers: [
				{ name: "llm", model: "m", baseUrl: "http://x", protocol: "p" },
			],
		},
	},
	{
		name: "inferenceProbes",
		call: (c) => c.inferenceProbes(),
		method: "GET",
		path: "/api/inference/probes",
		response: [probe],
	},
	{
		name: "startProbe",
		call: (c) => c.startProbe("llm"),
		method: "POST",
		path: "/api/inference/probes",
		body: { target: "llm" },
		response: { id: "p1" },
	},
	{
		name: "cancelProbe",
		call: (c) => c.cancelProbe("p/1"),
		method: "POST",
		path: "/api/inference/probes/p%2F1/cancel",
		body: {},
		response: {},
		result: undefined,
		parsed: false,
	},
]);

const target = {
	id: "t1",
	name: "n",
	model: "m",
	capability: "chat",
	protocol: "p",
	kind: "llm",
	source: "larm",
	onDemand: false,
	primary: true,
	testable: true,
};
const catalog = {
	targets: [target],
	errors: [],
	discoveredAt: null,
	revision: 1,
	stale: false,
};
const serviceRun = {
	id: "sr1",
	targetId: "t1",
	model: "m",
	kind: "llm",
	status: "running",
	phase: "running",
	created: 1,
	revision: 1,
};
contracts("service-tests client", [
	{
		name: "serviceCatalog",
		call: (c) => c.serviceCatalog(),
		method: "GET",
		path: "/api/service-tests/catalog",
		response: catalog,
	},
	{
		name: "refreshServiceCatalog",
		call: (c) => c.refreshServiceCatalog(),
		method: "POST",
		path: "/api/service-tests/catalog/refresh",
		body: {},
		response: catalog,
	},
	{
		name: "serviceRuns",
		call: (c) => c.serviceRuns(),
		method: "GET",
		path: "/api/service-tests/runs",
		response: [serviceRun],
	},
	{
		name: "startServiceTest",
		call: (c) =>
			c.startServiceTest({
				targetId: "t1",
				revision: 1,
				requestKey: uuid,
				input: { text: "hi" },
			}),
		method: "POST",
		path: "/api/service-tests/runs",
		body: {
			targetId: "t1",
			revision: 1,
			requestKey: uuid,
			input: { text: "hi" },
		},
		response: serviceRun,
	},
	{
		name: "diagnoseServices",
		call: (c) => c.diagnoseServices(),
		method: "POST",
		path: "/api/service-tests/diagnose",
		body: {},
		response: { ...serviceRun, kind: "diagnostics" },
	},
	{
		name: "cancelServiceTest",
		call: (c) => c.cancelServiceTest("sr/1"),
		method: "POST",
		path: "/api/service-tests/runs/sr%2F1/cancel",
		body: {},
		response: {},
		result: undefined,
		parsed: false,
	},
	{
		name: "retryServiceArtifact",
		call: (c) => c.retryServiceArtifact("sr1"),
		method: "POST",
		path: "/api/service-tests/runs/sr1/retry-artifact",
		body: {},
		response: serviceRun,
	},
	{
		name: "uploadTestAudio",
		call: (c) => c.uploadTestAudio(new Blob(["RIFF"])),
		method: "POST",
		path: "/api/service-tests/uploads",
		response: { id: uuid2 },
	},
]);

describe("service-tests artifact", () => {
	it("returns the artifact bytes as a Blob", async () => {
		const seen = stubFetch(
			() =>
				new Response("png-bytes", { headers: { "Content-Type": "image/png" } }),
		);
		const blob = await newClient().serviceArtifact("sr/1");
		expect(await blob.text()).toBe("png-bytes");
		expect(seen[0]?.path).toBe("/api/service-tests/runs/sr%2F1/artifact");
	});
	it("surfaces a 4xx {error} as ApiError", async () => {
		stubFetch(() =>
			Response.json({ error: "preview_expired" }, { status: 410 }),
		);
		await expect(newClient().serviceArtifact("sr1")).rejects.toMatchObject({
			status: 410,
			message: "preview_expired",
		});
	});
});

const grant = {
	workspaceId: "w1",
	operations: ["read"],
	branch: null,
	remote: null,
	network: "none",
	expiresAt: "2026-10-11T00:00:00.000Z",
	maxRuntimeMs: 3600000,
	maxDecisions: 10,
	progressIntervalMs: 300000,
};
const workTask = {
	id: "task1",
	kind: "coding",
	version: 1,
	title: "t",
	request: "do it",
	completionConditions: ["done"],
	origin: { source: "manual" },
	state: "registered",
	phase: null,
	revision: 1,
	authorityEpoch: 1,
	executionGeneration: 0,
	eventSeq: 0,
	grant,
	stopIntent: null,
	result: null,
	bodyExpired: false,
	metadataExpired: false,
	forgottenAt: null,
	executionDeadlineAt: null,
	createdAt: t0,
	updatedAt: t0,
	finishedAt: null,
};
const receipt = {
	taskId: "task1",
	state: "queued",
	revision: 2,
	authorityEpoch: 1,
	executionGeneration: 1,
};
const command = (extra = {}) => ({
	requestId: uuid,
	expectedRevision: 1,
	...extra,
});
contracts("tasks client", [
	{
		name: "createTask",
		call: (c) =>
			c.createTask({
				requestId: uuid,
				kind: "coding",
				version: 1,
				title: "t",
				request: "do it",
				completionConditions: ["done"],
				startMode: "start",
				grant: grant as never,
			}),
		method: "POST",
		path: "/api/tasks",
		response: receipt,
	},
	{
		name: "workTask",
		call: (c) => c.workTask("task/1"),
		method: "GET",
		path: "/api/tasks/task%2F1",
		response: {
			task: workTask,
			question: null,
			availableActions: ["start", "forget"],
			execution: null,
			supervisor: null,
			latestReport: null,
		},
	},
	{
		name: "workTasks",
		call: (c) => c.workTasks({ state: "queued", limit: 5 }),
		method: "GET",
		path: "/api/tasks?state=queued&limit=5",
		response: { items: [workTask], nextCursor: null },
	},
	{
		name: "workTaskEvents",
		call: (c) => c.workTaskEvents("task1", "3", 10),
		method: "GET",
		path: "/api/tasks/task1/events?cursor=3&limit=10",
		response: {
			items: [
				{
					seq: 4,
					taskId: "task1",
					reason: "start",
					state: "queued",
					phase: null,
					revision: 2,
					authorityEpoch: 1,
					executionGeneration: 1,
					createdAt: t0,
				},
			],
			nextCursor: "4",
			historyExpired: false,
		},
	},
	{
		name: "forgetTask",
		call: (c) => c.forgetTask("task1", uuid, 1),
		method: "POST",
		path: "/api/tasks/task1/forget",
		body: { requestId: uuid, expectedRevision: 1 },
		response: receipt,
	},
	{
		name: "startTask",
		call: (c) => c.startTask("task1", uuid, 1),
		method: "POST",
		path: "/api/tasks/task1/start",
		body: command(),
		response: receipt,
	},
	{
		name: "stopTask",
		call: (c) => c.stopTask("task1", uuid, 1, "pause"),
		method: "POST",
		path: "/api/tasks/task1/stop",
		body: command({ intent: "pause" }),
		response: { ...receipt, state: "stopping" },
	},
	{
		name: "amendTask",
		call: (c) =>
			c.amendTask("task1", {
				requestId: uuid,
				expectedRevision: 1,
				grant: grant as never,
			}),
		method: "POST",
		path: "/api/tasks/task1/amend",
		body: command({ grant }),
		response: receipt,
	},
	{
		name: "answerTask",
		call: (c) =>
			c.answerTask("task1", {
				requestId: uuid,
				expectedRevision: 1,
				questionId: "q1",
				answer: "yes",
			}),
		method: "POST",
		path: "/api/tasks/task1/answers",
		body: command({ questionId: "q1", answer: "yes" }),
		response: receipt,
	},
]);

const report = {
	kind: "progress",
	summary: "working",
	facts: [],
	limitations: [],
	evidenceRefs: [],
	snapshotHash: null,
	questionId: null,
	id: "rep1",
	taskId: "task1",
	sequence: 1,
	executionGeneration: 1,
	authorityEpoch: 1,
	taskRevision: 2,
	originConversationId: null,
	phase: "implementing",
	observedAt: 1,
	createdAt: 1,
	dedupeKey: "k",
	priority: "normal",
};
contracts("coding-supervision client (reports)", [
	{
		name: "taskReports",
		call: (c) => c.taskReports("task1", 2, 10),
		method: "GET",
		path: "/api/tasks/task1/reports?after=2&limit=10",
		response: { items: [report], nextCursor: null },
	},
]);
