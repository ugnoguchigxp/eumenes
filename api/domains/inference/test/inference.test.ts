import { afterEach, expect, spyOn, test } from "bun:test";
import {
	cleanup,
	messages,
	setup,
	wav,
	freshSignal,
} from "./inference.fixture";
import { settle, waitFor } from "../../../infrastructure/wait-for";
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});
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
	await settle();
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
	await waitFor(() => !!signal);
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
	await settle();
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
	await waitFor(() => h.inference.usage().length > 0);
	controller.abort();
	await expect(work).rejects.toThrow();
	expect(() => publish("late")).toThrow();
	release();
	await settle();
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
test("a host-fixed answer accepts its pending llm request without an accepted attempt, once, and only while allowed", async () => {
	const h = await setup();
	const id = await h.store.write((db) =>
		h.inference.captureInTransaction(db, "host-run", "llm", Date.now() + 10000),
	);
	const attempts = () =>
		h.store.read(
			(db) =>
				(
					db
						.query(
							"SELECT count(*) AS n FROM inference_attempts WHERE request_id=?",
						)
						.get(id) as { n: number }
				).n,
		);
	expect(h.store.read((db) => h.inference.validInTransaction(db, id))).toBe(
		false,
	);
	expect(
		await h.store.write((db) =>
			h.inference.acceptHostAnswerInTransaction(db, id),
		),
	).toBe(true);
	expect(attempts()).toBe(0);
	expect(h.store.read((db) => h.inference.validInTransaction(db, id))).toBe(
		true,
	);
	expect(h.inference.usage().every((u) => u.accepted === 0)).toBe(true);
	// Accepted already: it cannot be accepted again.
	expect(
		await h.store.write((db) =>
			h.inference.acceptHostAnswerInTransaction(db, id),
		),
	).toBe(false);
	// Not an answer request of the llm purpose, nor a request that does not exist.
	const tts = await h.store.write((db) =>
		h.inference.captureInTransaction(db, "host-run", "tts", Date.now() + 10000),
	);
	expect(
		await h.store.write((db) =>
			h.inference.acceptHostAnswerInTransaction(db, tts),
		),
	).toBe(false);
	expect(
		await h.store.write((db) =>
			h.inference.acceptHostAnswerInTransaction(db, "missing"),
		),
	).toBe(false);
});
test("a host-fixed answer follows earlier unadopted rounds, never an adopted answer, and is refused past its deadline", async () => {
	const h = await setup({ local: async () => "local-answer" });
	const open = await h.store.write((db) =>
		h.inference.captureInTransaction(db, "open-run", "llm", Date.now() + 10000),
	);
	await h.inference.executeRequest(
		open,
		messages,
		new AbortController().signal,
	);
	expect(
		await h.store.write((db) =>
			h.inference.acceptHostAnswerInTransaction(db, open),
		),
	).toBe(true);
	expect(
		h.store.read(
			(db) =>
				db
					.query(
						"SELECT count(*) AS n FROM inference_attempts WHERE request_id=? AND accepted=1",
					)
					.get(open) as { n: number },
		).n,
	).toBe(0);
	const adopted = await h.store.write((db) =>
		h.inference.captureInTransaction(
			db,
			"adopted-run",
			"llm",
			Date.now() + 10000,
		),
	);
	const receipt = await h.inference.executeRequest(
		adopted,
		messages,
		new AbortController().signal,
	);
	expect(
		await h.store.write((db) => h.inference.acceptInTransaction(db, receipt)),
	).toBe(true);
	expect(
		await h.store.write((db) =>
			h.inference.acceptHostAnswerInTransaction(db, adopted),
		),
	).toBe(false);
	// Past its deadline, a request is no longer acceptable: a route needs no revoking, as no provider is involved.
	const late = await h.store.write((db) =>
		h.inference.captureInTransaction(db, "late-run", "llm", Date.now() - 1),
	);
	expect(
		await h.store.write((db) =>
			h.inference.acceptHostAnswerInTransaction(db, late),
		),
	).toBe(false);
});
