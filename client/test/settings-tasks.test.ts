import { expect, it } from "vitest";
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
	agency: { emotion: true, idleSec: 20, interests: [], maxUnanswered: 1 },
	world: { enabled: false, curationResourceId: null },
	intent: { mode: "shadow", timeoutMs: 1500, searchScore: 0.6 },
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
		asrLanguages: ["ja", "en"],
		userName: "",
		persona: "butler",
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
]);

it.each(["test-profile", "test-profile-large"])(
	"settings client accepts and preserves profile %s",
	async (profile) => {
		const selected = { ...settings, larm: { ...settings.larm, profile } };
		stubFetch(() => Response.json(selected));
		expect((await newClient().settings()).larm.profile).toBe(profile);
	},
);

contracts("service-tests client", [
	{
		name: "uploadTestAudio",
		call: (c) => c.uploadTestAudio(new Blob(["RIFF"])),
		method: "POST",
		path: "/api/service-tests/uploads",
		response: { id: uuid2 },
	},
]);

const grant = {
	connectionRef: "c1",
	projectRef: "p1",
	sessionRefs: [],
	maxSessions: 1,
	operations: ["read"],
	expiresAt: "2026-10-11T00:00:00.000Z",
	maxRuntimeMs: 3600000,
	progressIntervalMs: 300000,
};
const workTask = {
	id: "task1",
	kind: "orchestration",
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
				kind: "orchestration",
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
