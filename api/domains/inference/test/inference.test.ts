import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
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
async function setup(
	options: {
		local?: LarmPort["answer"];
		localStream?: LarmPort["answerStream"];
		localSpeech?: LarmPort["speak"];
		judge?: LarmPort["judge"];
		decisionMs?: number;
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
	const inference = createInference(store, settings, {
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
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { store, settings, inference, calls, payloads, seen };
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
test("automatic intonation uses each phrase and its immutable manual baseline; disabling restores manual delivery", async () => {
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
	expect(adjustments).toEqual([1.32, undefined]);
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
				model: "gemma4-26b-a4b",
				started: Date.now(),
				httpStatus: 409,
				errorCode: "connection_idle_released",
				errorMessage:
					"provider bearer token belongs to an idle-released connection",
			});
			await options?.onExchange?.({
				connectionId: "replacement-connection",
				model: "gemma4-26b-a4b",
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
		model: "gemma4-26b-a4b",
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
				model: "gemma4-26b-a4b",
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
		motion: {
			type: "choice",
			choice: "greeting",
			confidence: 0.9,
			answer_confidence: 0.9,
		},
		voice: {
			type: "choice",
			choice: "bright",
			confidence: 0.8,
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
		{ utterance: "こんにちはサー！", phase: "response_ready" },
	]);
	expect(receipt.delivery).toMatchObject({
		motion: "greeting",
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
	expect(replay.delivery).toMatchObject({ motion: "greeting", source: "laya" });
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
	const pending = h.inference.executeRequest(next, "続き", abort.signal);
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
	const h = await setup({ localSpeech: async () => wav() });
	const before = h.settings.get().larm;
	await h.inference.speak("サンプル", new AbortController().signal, {
		voice: "Zundamon",
		style: "normal",
		speed: 1.4,
	});
	expect(h.seen.at(-1)).toMatchObject({
		voice: "Zundamon",
		style: "normal",
		speed: 1.4,
	});
	expect(h.settings.get().larm).toEqual(before);
});
