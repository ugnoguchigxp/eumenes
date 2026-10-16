import {
	createAttitudeDataset,
	migration as datasetMigration,
	type Sample,
} from "../../attitude-dataset";
import { RURI_MODEL, emotionSchema } from "../../delivery";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, WriterBusyError } from "../../../infrastructure/sqlite";
import {
	createSettings,
	migration as settingsMigration,
	epochsMigration as settingsEpochsMigration,
} from "../../settings";
import type { LarmPort } from "../../larm";
import {
	createInference,
	migration,
	parentsMigration,
	diagnosticsMigration,
	controlMigration,
	migrations as inferenceMigrations,
} from "..";
const cleanup: Array<() => Promise<void>> = [];
async function until(condition: () => boolean) {
	for (let i = 0; i < 200; i++) {
		if (condition()) return;
		await Bun.sleep(5);
	}
	throw new Error("condition_not_reached");
}
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});
const messages = [
	{ role: "system" as const, content: "system" },
	{ role: "user" as const, content: "hello" },
];
test("a call without a role is auxiliary: the output mode no longer decides the session", async () => {
	const roles: unknown[] = [];
	const h = await setup({
		local: async (_messages, _signal, options) => {
			roles.push(options?.sessionRole);
			return "{}";
		},
	});
	await h.inference.answer(messages, new AbortController().signal);
	const id = await h.store.write((db) =>
		h.inference.captureMaintenanceControlInTransaction(db, {
			subject: "independent-helper",
			deadline: Date.now() + 30000,
			maxOutputTokens: 512,
		}),
	);
	await h.inference.executeControl(id, messages, new AbortController().signal);
	expect(roles).toEqual(["auxiliary", "auxiliary"]);
});
test("the caller sets the session role per call; it is validated and recorded with the task on each attempt", async () => {
	const seen: unknown[] = [];
	const h = await setup({
		local: async (_messages, _signal, options) => {
			seen.push([options?.sessionRole, options?.taskId]);
			return "{}";
		},
	});
	const signal = new AbortController().signal;
	const answerRequest = () =>
		h.store.write((db) =>
			h.inference.captureInTransaction(
				db,
				crypto.randomUUID(),
				"llm",
				Date.now() + 30000,
			),
		);
	const controlRequest = () =>
		h.store.write((db) =>
			h.inference.captureBackgroundControlInTransaction(db, {
				taskId: "task",
				decisionId: crypto.randomUUID(),
				authorityEpoch: 1,
				executionGeneration: 1,
				deadline: Date.now() + 20000,
				taskDeadline: Date.now() + 30000,
				maxOutputTokens: 512,
			}),
		);
	// One answer request: a one-shot call, then the main answer, with the same request id.
	const shared = await answerRequest();
	const stream = (
		id: string,
		session?: Parameters<typeof h.inference.executeStream>[6],
	) =>
		h.inference.executeStream(
			id,
			messages,
			signal,
			() => {},
			undefined,
			undefined,
			session,
		);
	await stream(shared, { sessionRole: "auxiliary" });
	await stream(shared, { sessionRole: "main" });
	await stream(await answerRequest());
	// Control mode: a sub-agent call is allowed and carries its task.
	await h.inference.executeControl(
		await controlRequest(),
		messages,
		signal,
		undefined,
		{ sessionRole: "subagent", taskId: "agent:task-1" },
	);
	expect(seen).toEqual([
		["auxiliary", undefined],
		["main", undefined],
		["auxiliary", undefined],
		["subagent", "agent:task-1"],
	]);
	// Rejected before any attempt starts: main on a control request, a sub-agent without a task, a task on another role.
	const before = h.inference.usage().length;
	await expect(
		h.inference.executeControl(
			await controlRequest(),
			messages,
			signal,
			undefined,
			{
				sessionRole: "main",
			},
		),
	).rejects.toThrow("invalid_session_role");
	await expect(
		h.inference.executeControl(
			await controlRequest(),
			messages,
			signal,
			undefined,
			{
				sessionRole: "subagent",
			},
		),
	).rejects.toThrow("invalid_session_role");
	await expect(
		h.inference.executeControl(
			await controlRequest(),
			messages,
			signal,
			undefined,
			{
				sessionRole: "auxiliary",
				taskId: "task",
			},
		),
	).rejects.toThrow("invalid_session_role");
	await expect(
		stream(await answerRequest(), {
			sessionRole: "subagent",
			taskId: "bad id",
		}),
	).rejects.toThrow("invalid_session_role");
	expect(h.inference.usage()).toHaveLength(before);
	const attempts = h.store.read((db) =>
		db
			.query(
				"SELECT source,session_role,task_id,billing_path FROM inference_attempts ORDER BY started,rowid",
			)
			.all(),
	);
	expect(attempts).toEqual([
		{
			source: "larm",
			session_role: "auxiliary",
			task_id: null,
			billing_path: "larm",
		},
		{
			source: "larm",
			session_role: "main",
			task_id: null,
			billing_path: "larm",
		},
		{
			source: "larm",
			session_role: "auxiliary",
			task_id: null,
			billing_path: "larm",
		},
		{
			source: "larm",
			session_role: "subagent",
			task_id: "agent:task-1",
			billing_path: "larm",
		},
	]);
});
test("a cloud fallback attempt records the role and the connection's billing path", async () => {
	const h = await setup();
	await h.inference.answer(messages, new AbortController().signal);
	const row = h.store.read((db) =>
		db
			.query(
				"SELECT session_role,billing_path FROM inference_attempts WHERE source='cloud'",
			)
			.get(),
	);
	expect(row).toEqual({
		session_role: "auxiliary",
		billing_path: "openai-compatible",
	}); // The usage listing carries the path, for the chat screen's last-used display.
	expect(
		(h.inference.usage() as { source: string; billingPath: string }[])
			.filter((u) => u.source === "cloud")
			.map((u) => u.billingPath),
	).toEqual(["openai-compatible"]);
});
async function setup(
	options: {
		local?: LarmPort["answer"];
		localStream?: LarmPort["answerStream"];
		localSpeech?: LarmPort["speak"];
		judge?: LarmPort["judge"];
		prepareVoice?: LarmPort["prepareVoice"];
		decisionMs?: number;
		dataset?: boolean;
		speechText?: (text: string) => string;
		fetch?: typeof fetch;
		localMs?: number;
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-inference-"));
	const dbPath = join(dir, "test.db");
	const store = openStore(dbPath, [
		settingsMigration,
		migration,
		settingsEpochsMigration,
		parentsMigration,
		diagnosticsMigration,
		controlMigration,
		...inferenceMigrations.slice(4).map((m) => m.sql),
	]);
	const settings = await createSettings(store, { dbPath, env: {} });
	const s = settings.get();
	const connectionId = crypto.randomUUID();
	for (const purpose of ["llm", "asr", "tts"] as const) {
		const id = crypto.randomUUID();
		s.resources.push({
			id,
			connectionId,
			purpose,
			model: `fixture-${purpose}`,
			contextWindow: purpose === "llm" ? 8192 : null,
			voice: purpose === "tts" ? "fixture-voice" : null,
		});
		s.routes[purpose].fallbackId = id;
	}
	s.connections.push({
		id: connectionId,
		name: "Fixture",
		baseUrl: "http://127.0.0.1:19999/v1",
		enabled: true,
		epoch: 0,
		envRef: null,
	});
	await settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: 0,
		settings: s,
		keys: [{ connectionId, value: "fixture-key" }],
	});
	const calls: string[] = [];
	const seen: Array<{ voice: string; style?: string; speed?: number }> = [];
	const payloads: unknown[] = [];
	const port: LarmPort = {
		decisionModel: () => (options.dataset ? RURI_MODEL : null),
		prepareVoice: options.prepareVoice,
		status: () => ({ state: "unconfigured", capabilities: [] }),
		answerStream: options.localStream,
		judge: options.judge,
		connect: async () => {},
		answer:
			options.local ??
			(async () => {
				throw new Error("larm_unconfigured");
			}),
		transcribe: async () => {
			throw new Error("larm_control_503");
		},
		speak:
			options.localSpeech ??
			(async () => {
				throw new Error("larm_control_503");
			}),
		close: async () => {},
	};
	const fetcher = (async (url: URL | Request | string, init?: RequestInit) => {
		calls.push(String(url));
		payloads.push(init?.body);
		expect(new Headers(init?.headers).get("Authorization")).toBe(
			"Bearer fixture-key",
		);
		if (String(url).endsWith("audio/speech")) return new Response(wav());
		if (String(url).endsWith("audio/transcriptions"))
			return Response.json({ text: "音声入力" });
		return Response.json({
			choices: [{ message: { content: "cloud-answer" } }],
			usage: { prompt_tokens: 7, completion_tokens: 3 },
		});
	}) as typeof fetch;
	const datasetStore = options.dataset
		? openStore(join(dir, "dataset.sqlite3"), [datasetMigration])
		: undefined;
	const dataset = datasetStore
		? createAttitudeDataset(datasetStore, dir)
		: undefined;
	const inference = createInference(store, settings, {
		attitudeDataset: dataset,
		larmFactory: (s) => {
			seen.push(s.larm);
			return port;
		},
		fetch: options.fetch ?? fetcher,
		localMs: options.localMs,
		cloudMs: 1000,
		decisionMs: options.decisionMs,
		speechText: options.speechText,
	});
	cleanup.push(async () => {
		await inference.close();
		await dataset?.close();
		await datasetStore?.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { store, settings, inference, calls, payloads, seen, dataset, port };
}
function wav() {
	const b = new Uint8Array(48);
	b.set(new TextEncoder().encode("RIFF"));
	b.set(new TextEncoder().encode("WAVE"), 8);
	return b;
}
test("three purposes fall back once, adapters preserve paths and usage; no duplicate adoption", async () => {
	const h = await setup();
	expect(await h.inference.answer(messages, new AbortController().signal)).toBe(
		"cloud-answer",
	);
	expect(
		await h.inference.transcribe(wav(), new AbortController().signal),
	).toBe("音声入力");
	expect(
		await h.inference.speak("answer", new AbortController().signal),
	).toEqual(wav());
	expect(h.calls).toEqual([
		"http://127.0.0.1:19999/v1/chat/completions",
		"http://127.0.0.1:19999/v1/audio/transcriptions",
		"http://127.0.0.1:19999/v1/audio/speech",
	]);
	const usage = h.inference.usage() as {
		accepted: number;
		source: string;
		inputTokens: number | null;
	}[];
	expect(usage.filter((u) => u.accepted)).toHaveLength(3);
	expect(usage.filter((u) => u.source === "larm")).toHaveLength(3);
	expect(usage.some((u) => u.inputTokens === 7)).toBe(true);
});

test("service tests pin a cloud resource without changing routes or falling back", async () => {
	let localCalls = 0;
	const h = await setup({
		local: async () => {
			localCalls++;
			return "local";
		},
	});
	const before = h.settings.get();
	const id = before.resources.find((r) => r.purpose === "llm")!.id;
	expect(
		await h.inference.testResource(id, messages, AbortSignal.timeout(1000)),
	).toBe("cloud-answer");
	expect(localCalls).toBe(0);
	expect(h.settings.get()).toEqual(before);
	expect(h.inference.usage()).toEqual([]);
	before.routes.llm.cloudAllowed = false;
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: before.revision,
		settings: before,
		keys: [],
	});
	await expect(
		h.inference.testResource(id, messages, AbortSignal.timeout(1000)),
	).rejects.toBeDefined();
	expect(h.calls).toHaveLength(1);
});
test("cloud TTS keeps its own voice and speed from the accepted settings snapshot", async () => {
	const h = await setup();
	const s = h.settings.get();
	s.larm.voice = "local-voice";
	s.larm.speed = 0.7;
	const resource = s.resources.find((r) => r.purpose === "tts")!;
	resource.voice = "cloud-voice";
	resource.speed = 1.5;
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: s.revision,
		settings: s,
		keys: [],
	});
	const id = await h.store.write((db) =>
		h.inference.captureInTransaction(
			db,
			"speech-settings",
			"tts",
			Date.now() + 10000,
		),
	);
	const newer = h.settings.get();
	newer.resources.find((r) => r.purpose === "tts")!.speed = 1.9;
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: newer.revision,
		settings: newer,
		keys: [],
	});
	await h.inference.executeRequest(id, "answer", new AbortController().signal);
	expect(JSON.parse(String(h.payloads.at(-1)))).toMatchObject({
		voice: "cloud-voice",
		speed: 1.5,
		response_format: "wav",
	});
});
test("judge absence preserves the immutable manual baseline for every phrase", async () => {
	const adjustments: Array<number | undefined> = [];
	const h = await setup({
		localSpeech: async (_text, _signal, options) => {
			adjustments.push(options?.intonationScale);
			return wav();
		},
	});
	const s = h.settings.get();
	s.larm.autoIntonation = true;
	s.larm.intonationScale = 1.1;
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: s.revision,
		settings: s,
		keys: [],
	});
	const id = await h.store.write((db) =>
		h.inference.captureInTransaction(
			db,
			"question-phrase",
			"tts",
			Date.now() + 10000,
		),
	);
	const newer = h.settings.get();
	newer.larm.intonationScale = 1.9;
	newer.larm.autoIntonation = false;
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: newer.revision,
		settings: newer,
		keys: [],
	});
	await h.inference.executeRequest(
		id,
		"確認しますか？",
		new AbortController().signal,
	);
	await h.inference.speak(
		"ありがとうございます！",
		new AbortController().signal,
	);
	expect(adjustments).toEqual([undefined, undefined]);
});
test("authentication, invalid contracts and caller cancellation never trigger cloud", async () => {
	for (const code of [
		"larm_control_401",
		"larm_inference_403",
		"larm_invalid_catalog",
		"context_window_exceeded",
	]) {
		const h = await setup({
			local: async () => {
				throw new Error(code);
			},
		});
		await expect(
			h.inference.answer(messages, new AbortController().signal),
		).rejects.toThrow(code);
		expect(h.calls).toHaveLength(0);
	}
	const h = await setup();
	const controller = new AbortController();
	controller.abort();
	await expect(
		h.inference.answer(messages, controller.signal),
	).rejects.toThrow();
	expect(h.calls).toHaveLength(0);
});
test("local timeout fences a late adapter result; immutable snapshot and revocation at adoption", async () => {
	let localResolve!: (value: string) => void;
	const h = await setup({
		local: () =>
			new Promise((r) => {
				localResolve = r;
			}),
		localMs: 10,
	});
	const id = await h.store.write((db) =>
		h.inference.captureInTransaction(db, "test-run", "llm", Date.now() + 10000),
	);
	const changed = h.settings.get();
	changed.resources[0]!.model = "new-model";
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: changed.revision,
		settings: changed,
		keys: [],
	});
	const receipt = await h.inference.executeRequest(
		id,
		messages,
		new AbortController().signal,
	);
	expect(receipt.value).toBe("cloud-answer");
	expect(JSON.parse(h.payloads[0] as string).model).toBe("fixture-llm");
	localResolve("late-local");
	await Bun.sleep(10);
	const revoked = h.settings.get();
	revoked.routes.llm.cloudAllowed = false;
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: revoked.revision,
		settings: revoked,
		keys: [],
	});
	expect(
		await h.store.write((db) => h.inference.acceptInTransaction(db, receipt)),
	).toBe(false);
	expect(
		(h.inference.usage() as { accepted: number }[]).every(
			(u) => u.accepted === 0,
		),
	).toBe(true);
});
test("revocation aborts pending cloud; regrant does not revive old request", async () => {
	let signal: AbortSignal | undefined;
	let finish!: (r: Response) => void;
	const h = await setup({
		fetch: (async (_url: unknown, init?: RequestInit) => {
			signal = init?.signal ?? undefined;
			return new Promise((r) => {
				finish = r;
			});
		}) as typeof fetch,
	});
	const promise = h.inference.answer(messages, new AbortController().signal);
	for (let i = 0; i < 50 && !signal; i++) await Bun.sleep(2);
	const changed = h.settings.get();
	changed.routes.llm.cloudAllowed = false;
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: changed.revision,
		settings: changed,
		keys: [],
	});
	await expect(promise).rejects.toThrow("cancelled");
	expect(signal?.aborted).toBe(true);
	finish(Response.json({ choices: [{ message: { content: "late" } }] }));
	await Bun.sleep(5);
	expect(
		(h.inference.usage() as { accepted: number }[]).some((u) => u.accepted),
	).toBe(false);
});
test("acceptance updates rollback together with the caller transaction", async () => {
	const h = await setup();
	const id = await h.store.write((db) =>
		h.inference.captureInTransaction(db, "run", "llm", Date.now() + 10000),
	);
	const receipt = await h.inference.executeRequest(
		id,
		messages,
		new AbortController().signal,
	);
	await expect(
		h.store.write((db) => {
			expect(h.inference.validateReceiptInTransaction(db, receipt)).toBe(true);
			expect(h.inference.usage().every((u) => u.accepted === 0)).toBe(true);
			expect(
				h.inference.validateReceiptInTransaction(db, {
					...receipt,
					attemptId: "foreign",
				}),
			).toBe(false);
			expect(h.inference.acceptInTransaction(db, receipt)).toBe(true);
			throw new Error("rollback");
		}),
	).rejects.toThrow("rollback");
	expect(
		await h.store.write((db) => h.inference.acceptInTransaction(db, receipt)),
	).toBe(true);
	expect(
		await h.store.write((db) => h.inference.acceptInTransaction(db, receipt)),
	).toBe(false);
});

test("a failed stream cannot append a cloud fallback to already published local text", async () => {
	const h = await setup({
		localStream: async (_messages, _signal, delta) => {
			delta("途中");
			throw new Error("larm_control_503");
		},
	});
	const parts: string[] = [];
	await expect(
		h.inference.answerStream(messages, new AbortController().signal, (x) =>
			parts.push(x),
		),
	).rejects.toThrow("larm_control_503");
	expect(parts).toEqual(["途中"]);
	expect(h.calls).toHaveLength(0);
	expect(
		h.inference
			.usage()
			.every((x) => (x as { accepted: number }).accepted === 0),
	).toBe(true);
});
test("late provider deltas are fenced after caller cancellation", async () => {
	let publish: (text: string) => void = () => {};
	let release: () => void = () => {};
	const h = await setup({
		localStream: async (_messages, _signal, delta) => {
			publish = delta;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return "late";
		},
	});
	const controller = new AbortController(),
		parts: string[] = [];
	const work = h.inference.answerStream(messages, controller.signal, (x) =>
		parts.push(x),
	);
	await until(() => h.inference.usage().length > 0);
	controller.abort();
	await expect(work).rejects.toThrow();
	expect(() => publish("late")).toThrow();
	release();
	await Bun.sleep(1);
	expect(parts).toHaveLength(0);
	expect(h.calls).toHaveLength(0);
});

test("provider diagnostics preserve the rejected and recovered Connection IDs on the same attempt", async () => {
	const h = await setup({
		localStream: async (_messages, _signal, delta, options) => {
			await options?.onExchange?.({
				connectionId: "old-connection",
				model: "fixture-model",
				started: Date.now(),
				httpStatus: 409,
				errorCode: "connection_idle_released",
				errorMessage:
					"provider bearer token belongs to an idle-released connection",
			});
			await options?.onExchange?.({
				connectionId: "replacement-connection",
				model: "fixture-model",
				started: Date.now(),
				httpStatus: 200,
			});
			delta("承知しました");
			return "承知しました";
		},
	});
	expect(
		await h.inference.answerStream(messages, freshSignal(), () => {}),
	).toBe("承知しました");
	const usage = h.inference.usage();
	expect(usage).toHaveLength(1);
	expect(usage[0]).toMatchObject({
		source: "larm",
		status: "succeeded",
		model: "fixture-model",
		accepted: 1,
		providerDetails: [
			{
				connectionId: "old-connection",
				httpStatus: 409,
				errorCode: "connection_idle_released",
			},
			{ connectionId: "replacement-connection", httpStatus: 200 },
		],
	});
});

test("a failed provider still saves the rejected Connection ID and error fields", async () => {
	const h = await setup({
		local: async (_messages, _signal, options) => {
			await options?.onExchange?.({
				connectionId: "rejected-connection",
				model: "fixture-model",
				started: Date.now(),
				httpStatus: 409,
				errorCode: "connection_idle_released",
				errorMessage:
					"provider bearer token belongs to an idle-released connection",
			});
			throw new Error("larm_inference_409");
		},
	});
	await expect(h.inference.answer(messages, freshSignal())).rejects.toThrow(
		"larm_inference_409",
	);
	expect(h.inference.usage()[0]).toMatchObject({
		status: "failed",
		reason: "larm_inference_409",
		accepted: 0,
		providerDetails: [
			{
				connectionId: "rejected-connection",
				errorCode: "connection_idle_released",
			},
		],
	});
	expect(h.calls).toHaveLength(0);
});
function freshSignal() {
	return new AbortController().signal;
}

const judged = {
	answers: {
		emotion: {
			type: "choice",
			choice: "warmth",
			confidence: 0.9,
			answer_confidence: 0.8,
		},
	},
};
test("Laya judges the spoken text and carries one decision with bounded immutable voice settings", async () => {
	const states: unknown[] = [],
		parameters: Array<import("../../larm").LarmCallOptions | undefined> = [];
	const h = await setup({
		speechText: (text) => text.replace("SAAA", "サー"),
		judge: async (state) => {
			states.push(state);
			return judged;
		},
		localSpeech: async (_text, _signal, options) => {
			parameters.push(options);
			return wav();
		},
	});
	const s = h.settings.get();
	s.larm.autoIntonation = true;
	s.larm.speed = 1.1;
	s.larm.pitchScale = 0.01;
	s.larm.intonationScale = 1.2;
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: s.revision,
		settings: s,
		keys: [],
	});
	const id = await h.store.write((db) =>
		h.inference.captureInTransaction(db, "delivery", "tts", Date.now() + 10000),
	);
	const changed = h.settings.get();
	changed.larm.speed = 1.8;
	changed.larm.autoIntonation = false;
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: changed.revision,
		settings: changed,
		keys: [],
	});
	const receipt = await h.inference.executeRequest(
		id,
		"こんにちはSAAA！",
		freshSignal(),
	);
	expect(states).toEqual([
		{ response: "こんにちはサー！", current_chunk: "こんにちはサー！" },
	]);
	expect(receipt.delivery).toMatchObject({
		motion: "agreeing",
		tone: "bright",
		source: "laya",
		confidence: 0.8,
	});
	expect(parameters[0]?.speed).toBeCloseTo(1.15);
	expect(parameters[0]?.pitchScale).toBeCloseTo(0.03);
	expect(parameters[0]?.intonationScale).toBeCloseTo(1.35);
	await h.inference.speak("手動設定", freshSignal());
	expect(parameters[1]).not.toHaveProperty("speed");
	expect(parameters[1]).not.toHaveProperty("pitchScale");
	expect(parameters[1]).not.toHaveProperty("intonationScale");
	const beforeReplay = new Set(
		h.inference.usage().map((attempt) => attempt.id),
	);
	const replay = await h.inference.speakWithDelivery(
		"もう一度こんにちは！",
		freshSignal(),
	);
	expect(replay.wav).toEqual(wav());
	expect(replay.delivery).toMatchObject({ motion: "agreeing", source: "laya" });
	const replayAttempts = h.inference
		.usage()
		.filter((attempt) => !beforeReplay.has(attempt.id));
	expect(replayAttempts).toHaveLength(1);
	expect(replayAttempts[0]?.accepted).toBe(1);
});
test("decision timeout keeps manual voice, fences late results and cancellation prevents synthesis", async () => {
	let resolve!: (value: unknown) => void;
	let judging: AbortSignal | undefined;
	const parameters: unknown[] = [];
	const h = await setup({
		decisionMs: 10,
		judge: async (_state, _q, signal) => {
			judging = signal;
			return new Promise((r) => {
				resolve = r;
			});
		},
		localSpeech: async (_text, _signal, options) => {
			parameters.push(options);
			return wav();
		},
	});
	const s = h.settings.get();
	s.larm.autoIntonation = true;
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: s.revision,
		settings: s,
		keys: [],
	});
	const id = await h.store.write((db) =>
		h.inference.captureInTransaction(db, "timeout", "tts", Date.now() + 10000),
	);
	const receipt = await h.inference.executeRequest(
		id,
		"やった！",
		freshSignal(),
	);
	expect(receipt.delivery).toMatchObject({
		source: "fallback",
		reason: "timeout",
		motion: "neutral",
	});
	expect(parameters[0]).not.toHaveProperty("intonationScale");
	expect(judging?.aborted).toBe(true);
	resolve(judged);
	await Bun.sleep(1);
	expect(receipt.delivery?.source).toBe("fallback");
	const next = await h.store.write((db) =>
		h.inference.captureInTransaction(db, "cancel", "tts", Date.now() + 10000),
	);
	const abort = new AbortController();
	const pending = h.inference.executeRequest(
		next,
		"こんにちは。",
		abort.signal,
	);
	await until(() => judging !== undefined && !judging.aborted);
	abort.abort();
	await expect(pending).rejects.toThrow();
	resolve(judged);
	expect(parameters).toHaveLength(1);
	expect(h.calls).toHaveLength(0);
});
test("speech text is rewritten for the local provider and for the cloud fallback", async () => {
	const local: string[] = [];
	const h = await setup({
		speechText: (text) => text.replace("SAAA", "サー"),
		localSpeech: async (text) => {
			local.push(text);
			return wav();
		},
	});
	await h.inference.speak("SAAAです", new AbortController().signal);
	expect(local).toEqual(["サーです"]);
	const cloud = await setup({
		speechText: (text) => text.replace("SAAA", "サー"),
	});
	await cloud.inference.speak("SAAAです", new AbortController().signal);
	expect(JSON.parse(cloud.payloads.at(-1) as string).input).toBe("サーです");
});

test("speak with an override synthesizes with unsaved voice settings without changing saved ones", async () => {
	let observed: import("../../larm").LarmCallOptions | undefined;
	const h = await setup({
		localSpeech: async (_text, _signal, options) => {
			observed = options;
			return wav();
		},
	});
	const before = h.settings.get().larm;
	await h.inference.speak("サンプル", new AbortController().signal, {
		voice: "Zundamon",
		style: "normal",
		speed: 1.4,
	});
	expect(observed?.speechOverride).toMatchObject({
		voice: "Zundamon",
		style: "normal",
		speed: 1.4,
	});
	expect(h.settings.get().larm).toEqual(before);
});

test("sample voice overrides remain usable with English speech routing enabled; authority uses saved settings", async () => {
	let observed: import("../../larm").LarmCallOptions | undefined;
	const h = await setup({
		localSpeech: async (_text, _signal, options) => {
			observed = options;
			return wav();
		},
	});
	await enableEnglishSpeech(h);
	const before = h.settings.get();
	expect(
		await h.inference.speak("試聴です。", freshSignal(), {
			voice: "Zundamon",
			style: "normal",
			speed: 1.4,
			pitchScale: 0.03,
			intonationScale: 1.2,
		}),
	).toEqual(wav());
	expect(observed?.speechOverride).toMatchObject({
		voice: "Zundamon",
		style: "normal",
		speed: 1.4,
		pitchScale: 0.03,
		intonationScale: 1.2,
	});
	expect(h.settings.get()).toEqual(before);
	expect(h.seen).toHaveLength(1);
	expect(
		h.inference.usage().some((r) => r.purpose === "tts" && r.accepted),
	).toBe(true);
});

test("a sample shares the existing port through unrelated saves", async () => {
	let finish!: (bytes: Uint8Array) => void;
	let entered = false;
	const h = await setup({
		localSpeech: async () => {
			entered = true;
			return new Promise((resolve) => {
				finish = resolve;
			});
		},
	});
	await enableEnglishSpeech(h, true);
	const close = spyOn(h.port, "close");
	const sample = h.inference
		.speak("試聴です。", freshSignal(), { voice: "Zundamon", speed: 1.1 })
		.catch((e) => e);
	await until(() => entered);
	const unrelated = h.settings.get();
	unrelated.general.agentName = "changed-name";
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: unrelated.revision,
		settings: unrelated,
		keys: [],
	});
	expect(close).not.toHaveBeenCalled();
	finish(wav());
	expect(await sample).toEqual(wav());
	expect(
		h.inference.usage().filter((r) => r.purpose === "tts" && r.accepted),
	).toHaveLength(1);
});

test("Ruri dataset captures real-turn receipt adoption once; a technical collection request does not delay answer or TTS", async () => {
	let calls = 0;
	const h = await setup({
		dataset: true,
		local: async () => "手順を説明します。",
		localSpeech: async () => wav(),
		judge: async () => {
			calls++;
			return {
				model: RURI_MODEL,
				answers: {
					emotion: {
						type: "choice",
						choice: "none",
						confidence: 0.9,
						answer_confidence: 0.9,
						logits: Object.fromEntries(
							emotionSchema.options.map((k) => [k, k === "none" ? 3 : 0]),
						),
						probabilities: Object.fromEntries(
							emotionSchema.options.map((k) => [k, k === "none" ? 0.9 : 0.02]),
						),
					},
				},
			};
		},
	});
	await h.dataset!.setEnabled(true);
	const id = await h.store.write((db) =>
		h.inference.captureInTransaction(db, "real-run", "llm", Date.now() + 10000),
	);
	const preparation = {
		collection: {
			conversationId: "conversation",
			turnId: "real-run",
			granularity: "answer" as const,
			chunkOrder: null,
		},
	};
	const receipt = await h.inference.executeStream(
		id,
		[{ role: "user", content: "設定方法は？" }],
		freshSignal(),
		() => {},
		preparation,
	);
	expect(receipt.delivery!.source).toBe("ruri");
	expect(calls).toBe(1);
	await h.dataset!.drain();
	expect(h.dataset!.status().successful).toBe(1);
	await h.store.write((db) => h.inference.acceptInTransaction(db, receipt));
	const audio = await h.inference.speakWithDelivery(
		"手順を説明します。",
		freshSignal(),
		{ delivery: receipt.delivery, collection: preparation.collection },
	);
	expect(audio.wav.length).toBeGreaterThan(0);
	expect(calls).toBe(1);

	await h.dataset!.drain();
	const sample = h.dataset!.get(
		h.dataset!.list()[0]!.sample_id,
		false,
	) as Sample;
	expect(sample.user_utterance).toBe("設定方法は？");
	expect(sample.adopted?.source).toBe("ruri");
	expect(sample.adopted?.voice_application).toBe("manual");
	expect(sample.adopted?.tone).toBeNull();
	expect(sample.primary_label).toBeNull();
});

test("control calls preserve exact context, stay local, skip emotion judgement, and rejected JSON is never adopted", async () => {
	let judgement = 0;
	let opts: unknown;
	const h = await setup({
		dataset: true,
		judge: async () => {
			judgement++;
			throw new Error("unexpected_judge");
		},
		local: async (_messages, _signal, options) => {
			opts = options;
			return '{"action":"respond"}';
		},
	});
	const id = await h.store.write((db) => {
		h.inference.captureInTransaction(
			db,
			"root-control",
			"llm",
			Date.now() + 10000,
		);
		return h.inference.captureControlInTransaction(db, {
			subject: "agent:control:1",
			policySubject: "root-control",
			deadline: Date.now() + 9000,
			maxOutputTokens: 2048,
		});
	});
	const receipt = await h.inference.executeControl(
		id,
		messages,
		new AbortController().signal,
	);
	expect(receipt.value).toBe('{"action":"respond"}');
	expect(opts).toMatchObject({
		contextPolicy: "exact",
		maxOutputTokens: 2048,
		jsonOutput: true,
	});
	expect(judgement).toBe(0);
	expect(h.calls).toHaveLength(0);
	expect(receipt.delivery).toBeUndefined();
	await h.store.write((db) =>
		h.inference.rejectControlInTransaction(db, receipt, "invalid_control_json"),
	);
	expect(
		await h.store.write((db) => h.inference.acceptInTransaction(db, receipt)),
	).toBe(false);
	expect(
		h.store.read((db) =>
			db.query("SELECT status,mode FROM inference_requests WHERE id=?").get(id),
		),
	).toEqual({ status: "rejected", mode: "control" });
});

test("only a structured-output control request sends the output schema to LARM; others stay plain JSON-object", async () => {
	const seen: Array<Record<string, unknown> | undefined> = [];
	const h = await setup({
		local: async (_messages, _signal, options) => {
			seen.push(options?.jsonSchema);
			return "{}";
		},
	});
	const outputSchema = {
		type: "object",
		properties: { done: { type: "boolean" } },
		required: ["done"],
		additionalProperties: false,
	};
	const background = (decisionId: string, structuredOutput?: boolean) =>
		h.store.write((db) =>
			h.inference.captureBackgroundControlInTransaction!(db, {
				taskId: "task",
				decisionId,
				authorityEpoch: 1,
				executionGeneration: 1,
				deadline: Date.now() + 20000,
				taskDeadline: Date.now() + 30000,
				maxOutputTokens: 512,
				route: "conversation",
				...(structuredOutput ? { structuredOutput } : {}),
			}),
		);
	const control = { instructions: "step", outputSchema };
	const signal = new AbortController().signal;
	const plain = await h.store.write((db) =>
		h.inference.captureMaintenanceControlInTransaction(db, {
			subject: "schema-route",
			deadline: Date.now() + 30000,
			maxOutputTokens: 512,
		}),
	);
	await h.inference.executeControl(plain, messages, signal, control);
	await h.inference.executeControl(
		await background("plain"),
		messages,
		signal,
		control,
	);
	await h.inference.executeControl(
		await background("structured", true),
		messages,
		signal,
		control,
	);
	await h.inference.answer(messages, signal);
	expect(seen).toEqual([undefined, undefined, outputSchema, undefined]);
});

test("a background control keeps the conversation route only when asked, and a different binding conflicts", async () => {
	const h = await setup();
	const capture = (decisionId: string, route?: "conversation") =>
		h.store.write((db) =>
			h.inference.captureBackgroundControlInTransaction!(db, {
				taskId: "task",
				decisionId,
				authorityEpoch: 1,
				executionGeneration: 1,
				deadline: Date.now() + 20000,
				taskDeadline: Date.now() + 30000,
				maxOutputTokens: 512,
				...(route ? { route } : {}),
			}),
		);
	const routeOf = (id: string) =>
		h.store.read((db) => {
			const row = db
				.query("SELECT snapshot FROM inference_requests WHERE id=?")
				.get(id) as { snapshot: string };
			const { llm } = JSON.parse(row.snapshot).routes;
			return [llm.mode, llm.cloudAllowed];
		});
	const larmOnly = await capture("a");
	expect(routeOf(larmOnly)).toEqual(["larm-only", false]);
	const conversation = await capture("b", "conversation");
	expect(routeOf(conversation)).not.toEqual(["larm-only", false]);
	await expect(capture("b")).rejects.toThrow("background_control_conflict");
});

test("a background control on a saved resource goes to that resource only, and falls back to the conversation route when it can not be used", async () => {
	const h = await setup();
	const capture = (decisionId: string, resourceId: string) =>
		h.store.write((db) =>
			h.inference.captureBackgroundControlInTransaction!(db, {
				taskId: "task",
				decisionId,
				authorityEpoch: 1,
				executionGeneration: 1,
				deadline: Date.now() + 20000,
				taskDeadline: Date.now() + 30000,
				maxOutputTokens: 512,
				route: { resourceId },
			}),
		);
	const routeOf = (id: string) =>
		h.store.read((db) => {
			const row = db
				.query("SELECT snapshot FROM inference_requests WHERE id=?")
				.get(id) as { snapshot: string };
			const { llm } = JSON.parse(row.snapshot).routes;
			return [llm.mode, llm.fallbackId];
		});
	const saved = h.settings.get();
	const llm = saved.resources.find((r) => r.purpose === "llm")!;
	const extra = crypto.randomUUID();
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: saved.revision,
		settings: {
			...saved,
			resources: [
				...saved.resources,
				{ ...llm, id: extra, model: "fixture-llm-2" },
			],
		},
		keys: [],
	});
	expect(routeOf(await capture("a", extra))).toEqual(["cloud-only", extra]);
	// Not a registered LLM resource: no path to compare with the conversation route's cloud, so LARM only.
	expect(routeOf(await capture("b", crypto.randomUUID()))).toEqual([
		"larm-only",
		llm.id,
	]);
	// The conversation route forbids the cloud: the resource is not used.
	const now = h.settings.get();
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: now.revision,
		settings: {
			...now,
			routes: {
				...now.routes,
				llm: { ...now.routes.llm, cloudAllowed: false },
			},
		},
		keys: [],
	});
	expect(routeOf(await capture("c", extra))).toEqual([
		"larm-preferred",
		llm.id,
	]);
});

// RT-12: a probe row must never stay "running" and block new probes.
const probeRow = (
	store: Awaited<ReturnType<typeof setup>>["store"],
	id: string,
) =>
	store.read(
		(db) =>
			db
				.query("SELECT status,error FROM inference_probes WHERE id=?")
				.get(id) as { status: string; error: string | null } | null,
	);
test("a probe stuck running for over 10 minutes is marked probe_stale and a new probe starts", async () => {
	const { store, inference, settings } = await setup();
	await store.write((db) =>
		db
			.query("INSERT INTO inference_probes VALUES(?,?,'running',NULL,?,?)")
			.run("old", "larm", settings.get().revision, Date.now() - 11 * 60_000),
	);
	const { id } = await inference.startProbe("larm");
	expect(probeRow(store, "old")).toEqual({
		status: "failed",
		error: "probe_stale",
	});
	await until(() => probeRow(store, id)?.status === "succeeded");
});
test("a probe registered inside a transaction runs after the commit and only if it committed", async () => {
	const { store, inference, settings } = await setup();
	const registered = await store.write((db) =>
		inference.startProbeInTransaction(db, "larm"),
	);
	expect(probeRow(store, registered.id)?.status).toBe("running");
	registered.launch();
	await until(() => probeRow(store, registered.id)?.status === "succeeded");
	// A rolled-back registration leaves no row and launching it does nothing.
	let lost: ReturnType<typeof inference.startProbeInTransaction> | undefined;
	await store
		.write((db) => {
			lost = inference.startProbeInTransaction(db, "larm");
			throw new Error("rolled_back");
		})
		.catch(() => undefined);
	expect(probeRow(store, lost!.id)).toBeNull();
	lost!.launch();
	expect(probeRow(store, lost!.id)).toBeNull();
	// An unknown target is refused before a row is written.
	await expect(
		store.write((db) =>
			inference.startProbeInTransaction(db, crypto.randomUUID()),
		),
	).rejects.toThrow("invalid_probe_target");
	// A resource target runs against its saved resource.
	const resource = settings.get().resources[0]!;
	const second = await store.write((db) =>
		inference.startProbeInTransaction(db, resource.id),
	);
	second.launch();
	await until(() => probeRow(store, second.id)?.status !== "running");
});
test("a probe cancel is a mark written by the transaction: a rollback leaves it running", async () => {
	const { store, inference, settings } = await setup();
	await store.write((db) =>
		db
			.query("INSERT INTO inference_probes VALUES(?,?,'running',NULL,?,?)")
			.run("live", "larm", settings.get().revision, Date.now()),
	);
	await store
		.write((db) => {
			inference.cancelProbeInTransaction(db, "live");
			throw new Error("rolled_back");
		})
		.catch(() => undefined);
	expect(probeRow(store, "live")?.status).toBe("running");
	await store.write((db) => inference.cancelProbeInTransaction(db, "live"));
	expect(probeRow(store, "live")?.status).toBe("cancelling");
	// Only a running probe is marked; a stuck mark is failed like a stuck run.
	await expect(
		store.write((db) => inference.cancelProbeInTransaction(db, "live")),
	).rejects.toThrow("probe_not_running");
	await expect(
		store.write((db) => inference.cancelProbeInTransaction(db, "none")),
	).rejects.toThrow("probe_not_found");
	await inference.recover();
	expect(probeRow(store, "live")?.status).toBe("interrupted");
});
test("a recent running probe still blocks a new one", async () => {
	const { store, inference, settings } = await setup();
	await store.write((db) =>
		db
			.query("INSERT INTO inference_probes VALUES(?,?,'running',NULL,?,?)")
			.run("recent", "larm", settings.get().revision, Date.now() - 60_000),
	);
	await expect(inference.startProbe("larm")).rejects.toThrow(
		"invalid_probe_busy",
	);
	expect(probeRow(store, "recent")?.status).toBe("running");
});
test("the final probe status survives a momentarily full writer queue", async () => {
	const { store, inference } = await setup();
	const write = store.write.bind(store);
	let writes = 0;
	const spy = spyOn(store, "write").mockImplementation(((
		operation: Parameters<typeof write>[0],
	) =>
		writes++ === 1
			? Promise.reject(new WriterBusyError())
			: write(operation)) as typeof store.write);
	try {
		const { id } = await inference.startProbe("larm");
		await until(() => probeRow(store, id)?.status === "succeeded");
		expect(writes).toBeGreaterThanOrEqual(3);
	} finally {
		spy.mockRestore();
	}
});

test("a non-network TypeError from the larm adapter does not fall back to cloud", async () => {
	const h = await setup({
		local: async () => {
			throw new TypeError("Cannot read properties of undefined (reading 'x')");
		},
	});
	await expect(
		h.inference.answer(messages, new AbortController().signal),
	).rejects.toThrow("inference_failed");
	expect(h.calls).toHaveLength(0);
});

test("transport-level TypeErrors from the larm adapter still fall back to cloud", async () => {
	const errors = [
		Object.assign(new TypeError("Unable to connect"), {
			code: "ConnectionRefused",
		}),
		Object.assign(
			new TypeError("The socket connection was closed unexpectedly."),
			{ code: "ECONNRESET" },
		),
		new TypeError("terminated"),
	];
	for (const error of errors) {
		const h = await setup({
			local: async () => {
				throw error;
			},
		});
		expect(
			await h.inference.answer(messages, new AbortController().signal),
		).toBe("cloud-answer");
		expect(h.calls).toHaveLength(1);
	}
});

test("a speech chunk gets its own short deadline when the turn's deadline is nearly over", async () => {
	const h = await setup();
	const before = Date.now();
	const chunkId = await h.store.write((db) => {
		h.inference.captureInTransaction(db, "voice-1", "tts", Date.now() + 1000);
		return h.inference.captureSpeechChunkInTransaction(db, "voice-1", 0);
	});
	const row = h.store.read(
		(db) =>
			db
				.query("SELECT deadline FROM inference_requests WHERE id=?")
				.get(chunkId) as { deadline: number },
	);
	expect(row.deadline).toBeGreaterThanOrEqual(before + 60_000);
});

test("streaming checks authority once per commit generation, not once per delta", async () => {
	let valid = () => 0;
	let during = 0;
	const h = await setup({
		localStream: async (_messages, _signal, delta) => {
			const before = valid();
			for (let i = 0; i < 10; i++) delta(`d${i}`);
			during = valid() - before;
			return "d0d1d2d3d4d5d6d7d8d9";
		},
	});
	const spy = spyOn(h.settings, "valid");
	valid = () => spy.mock.calls.length;
	const parts: string[] = [];
	await h.inference.answerStream(messages, new AbortController().signal, (x) =>
		parts.push(x),
	);
	expect(parts).toHaveLength(10);
	expect(during).toBe(1);
});

test("a request revoked mid-stream stops delivering deltas at the next delta", async () => {
	let gate: () => void = () => {};
	let reached: () => void = () => {};
	const waiting = new Promise<void>((resolve) => {
		reached = resolve;
	});
	const h = await setup({
		localStream: async (_messages, _signal, delta) => {
			for (let i = 0; i < 5; i++) delta(`d${i}`);
			reached();
			await new Promise<void>((resolve) => {
				gate = resolve;
			});
			for (let i = 5; i < 10; i++) delta(`d${i}`);
			return "unused";
		},
	});
	const parts: string[] = [];
	const work = h.inference
		.answerStream(messages, new AbortController().signal, (x) => parts.push(x))
		.catch((error: Error) => error);
	await waiting;
	await h.store.write((db) => {
		db.query("UPDATE inference_requests SET status='cancelled'").run();
	});
	gate();
	const result = await work;
	expect(result).toBeInstanceOf(Error);
	expect(parts).toEqual(["d0", "d1", "d2", "d3", "d4"]);
});

async function enableEnglishSpeech(
	h: Awaited<ReturnType<typeof setup>>,
	localOnly = false,
) {
	const s = h.settings.get();
	s.larm.englishSpeechEnabled = true;
	if (localOnly) s.routes.tts.mode = "larm-only";
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: s.revision,
		settings: s,
		keys: [],
	});
}

test("each clause routes by its own text; English bypasses the Japanese dictionary; disabling routing keeps the Japanese voice", async () => {
	const spoken: Array<[string, string | undefined]> = [];
	const h = await setup({
		speechText: (text) => text.replace("API", "エーピーアイ"),
		localSpeech: async (text, _signal, options) => {
			spoken.push([text, options?.speechLanguage]);
			return wav();
		},
	});
	await enableEnglishSpeech(h, true);
	await h.inference.speakWithDelivery("Open the API settings.", freshSignal());
	await h.inference.speakWithDelivery("APIを確認します。", freshSignal());
	await h.inference.speak(
		"ここで Open the settings を押します。",
		freshSignal(),
	);
	const value = h.settings.get();
	value.larm.englishSpeechEnabled = false;
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: value.revision,
		settings: value,
		keys: [],
	});
	await h.inference.speak("Open the settings.", freshSignal());
	expect(spoken).toEqual([
		["Open the API settings.", "en"],
		["エーピーアイを確認します。", "ja"],
		// A mixed request that was not split is spoken by the Japanese voice.
		["ここで Open the settings を押します。", "ja"],
		["Open the settings.", undefined],
	]);
	expect(
		h.inference.usage().filter((r) => r.purpose === "tts" && r.accepted).length,
	).toBe(4);
});

test("without an English voice an English clause is spoken by the Japanese voice with its dictionary", async () => {
	const spoken: Array<[string, string | undefined]> = [];
	const h = await setup({
		speechText: (text) => `辞書${text}`,
		localSpeech: async (text, _signal, options) => {
			if (options?.speechLanguage === "en")
				throw new Error("speech_tts_target_unavailable");
			spoken.push([text, options?.speechLanguage]);
			return wav();
		},
	});
	await enableEnglishSpeech(h, true);
	expect(
		await h.inference.speak("Thank you for waiting.", freshSignal()),
	).toEqual(wav());
	expect(spoken).toEqual([["辞書Thank you for waiting.", "ja"]]);
	expect(h.calls).toEqual([]);
	expect(
		h.inference.usage().filter((r) => r.purpose === "tts" && r.accepted).length,
	).toBe(1);
});

test("an English voice synthesis error is not retried with the Japanese voice", async () => {
	const languages: Array<string | undefined> = [];
	const h = await setup({
		localSpeech: async (_text, _signal, options) => {
			languages.push(options?.speechLanguage);
			throw new Error("larm_inference_500");
		},
	});
	await enableEnglishSpeech(h, true);
	await expect(
		h.inference.speak("Thank you for waiting.", freshSignal()),
	).rejects.toThrow("larm_inference_500");
	expect(languages).toEqual(["en"]);
});

test("when the LARM voices are unavailable every clause falls back to cloud speech without language routing", async () => {
	const languages: Array<string | undefined> = [];
	const h = await setup({
		speechText: (text) => `辞書${text}`,
		localSpeech: async (_text, _signal, options) => {
			languages.push(options?.speechLanguage);
			throw new Error(
				options?.speechLanguage === "en"
					? "speech_tts_target_unavailable"
					: "larm_inference_503",
			);
		},
	});
	await enableEnglishSpeech(h);
	expect(
		await h.inference.speak("Thank you for waiting.", freshSignal()),
	).toEqual(wav());
	expect(await h.inference.speak("今日は晴れです。", freshSignal())).toEqual(
		wav(),
	);
	// English falls to the Japanese voice first; each voice cools down on its own.
	expect(languages).toEqual(["en", "ja", "ja"]);
	const speech = h.calls.filter((url) => url.endsWith("audio/speech"));
	expect(speech).toHaveLength(2);
	const inputs = h.payloads
		.filter((body): body is string => typeof body === "string")
		.map((body) => JSON.parse(body) as { input?: string })
		.map((body) => body.input);
	expect(inputs).toEqual([
		"辞書Thank you for waiting.",
		"辞書今日は晴れです。",
	]);
});

test("a dedicated resource that can not be used falls back to the conversation route only on the same billing path", async () => {
	const h = await setup();
	const saved = h.settings.get();
	const llm = saved.resources.find((r) => r.purpose === "llm")!;
	const conversation = saved.connections.find(
		(c) => c.id === llm.connectionId,
	)!;
	const make = (kind: "codex-sdk" | undefined) => {
		const connectionId = crypto.randomUUID();
		const resourceId = crypto.randomUUID();
		return {
			connection: { ...conversation, id: connectionId, enabled: false, kind },
			resource: { ...llm, id: resourceId, connectionId },
		};
	};
	const samePath = make(undefined);
	const otherPath = make("codex-sdk");
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: saved.revision,
		settings: {
			...saved,
			connections: [
				...saved.connections,
				samePath.connection,
				otherPath.connection,
			],
			resources: [...saved.resources, samePath.resource, otherPath.resource],
		},
		keys: [],
	});
	const routeOf = (id: string) =>
		h.store.read((db) => {
			const row = db
				.query("SELECT snapshot FROM inference_requests WHERE id=?")
				.get(id) as { snapshot: string };
			const { llm } = JSON.parse(row.snapshot).routes;
			return [llm.mode, llm.cloudAllowed, llm.fallbackId];
		});
	const background = (decisionId: string, resourceId: string) =>
		h.store.write((db) =>
			h.inference.captureBackgroundControlInTransaction!(db, {
				taskId: "task",
				decisionId,
				authorityEpoch: 1,
				executionGeneration: 1,
				deadline: Date.now() + 20000,
				taskDeadline: Date.now() + 30000,
				maxOutputTokens: 512,
				route: { resourceId },
			}),
		);
	const root = await h.store.write((db) =>
		h.inference.captureInTransaction(db, "root", "llm", Date.now() + 60000),
	);
	expect(root).toBeTruthy();
	const control = (subject: string, resourceId: string) =>
		h.store.write((db) =>
			h.inference.captureControlInTransaction!(db, {
				subject,
				policySubject: "root",
				deadline: Date.now() + 20000,
				maxOutputTokens: 512,
				route: { resourceId },
			}),
		);
	// Same billing path: the saved conversation route, as before.
	const keep = ["larm-preferred", true, llm.id];
	expect(routeOf(await background("same", samePath.resource.id))).toEqual(keep);
	expect(routeOf(await control("agent:same", samePath.resource.id))).toEqual(
		keep,
	);
	// Another billing path: the call stays on LARM, it is not moved to the conversation's cloud.
	const larmOnly = ["larm-only", false, llm.id];
	expect(routeOf(await background("other", otherPath.resource.id))).toEqual(
		larmOnly,
	);
	expect(routeOf(await control("agent:other", otherPath.resource.id))).toEqual(
		larmOnly,
	);
	// Without a route a control request stays on LARM, as before.
	const plain = await h.store.write((db) =>
		h.inference.captureControlInTransaction!(db, {
			subject: "agent:plain",
			policySubject: "root",
			deadline: Date.now() + 20000,
			maxOutputTokens: 512,
		}),
	);
	expect(routeOf(plain)).toEqual(larmOnly);
});
