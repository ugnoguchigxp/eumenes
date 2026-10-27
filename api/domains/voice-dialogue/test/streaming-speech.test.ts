import { expect, test } from "bun:test";
import type { LarmCallOptions, LarmPort } from "../../larm";
import { emotionSchema, type Emotion } from "../../delivery";
import { settle } from "../../../infrastructure/wait-for";
import { createContinuityService } from "../../continuity";
import { setup, say, until, wav } from "./settings-voice.fixture";

function gate<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}
function ruri(emotion: Emotion, confidence = 0.9) {
	return {
		answers: {
			emotion: {
				type: "choice",
				choice: emotion,
				confidence,
				answer_confidence: confidence,
				logits: Object.fromEntries(
					emotionSchema.options.map((label) => [
						label,
						label === emotion ? 2 : 0,
					]),
				),
				probabilities: Object.fromEntries(
					emotionSchema.options.map((label) => [
						label,
						label === emotion ? confidence : (1 - confidence) / 5,
					]),
				),
			},
		},
	};
}
function stream() {
	const done = gate<string>();
	let delta: ((text: string) => void) | undefined;
	let text = "";
	let signal: AbortSignal | undefined;
	const answerStream: LarmPort["answerStream"] = async (
		_messages,
		abort,
		onDelta,
	) => {
		signal = abort;
		delta = onDelta;
		return done.promise;
	};
	return {
		answerStream,
		get started() {
			return !!delta;
		},
		get signal() {
			return signal;
		},
		push(value: string) {
			text += value;
			delta!(value);
		},
		finish() {
			done.resolve(text);
		},
		fail(reason: Error) {
			done.reject(reason);
		},
	};
}
async function start(
	h: Awaited<ReturnType<typeof setup>>,
	source: ReturnType<typeof stream>,
) {
	const id = crypto.randomUUID(),
		session = crypto.randomUUID();
	h.voice.start(session, 1);
	await say(h, session, id);
	await until(() => source.started);
	return id;
}

test("clauses are synthesized during generation, keep their own tone and are not repeated at adoption", async () => {
	const source = stream();
	const events: string[] = [];
	const states: Array<Record<string, string>> = [];
	const options: Array<LarmCallOptions | undefined> = [];
	const h = await setup(undefined, {
		transcribe: async () => "話してください。",
		answerStream: source.answerStream,
		judge: async (state) => {
			states.push(state);
			events.push(`judge:${state.current_chunk}`);
			return ruri(states.length === 1 ? "joy" : "empathy");
		},
		speak: async (text, _signal, settings) => {
			events.push(`tts:${text}`);
			options.push(settings);
			return wav();
		},
	});
	const settings = h.settings.get();
	settings.larm.autoIntonation = true;
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: settings.revision,
		settings,
		keys: [],
	});
	const id = await start(h, source);
	const runId = h.voice.get(id)!.runId!;
	source.push("よかった、大変でしたね。");
	await until(() => h.voice.get(id)?.audioChunks.length === 2);
	expect(states).toHaveLength(2);
	expect(h.dialogue.get(runId)?.status).toBe("running");
	expect(h.dialogue.answerText(runId)).toBeNull();
	expect(h.dialogue.progress(runId)?.text).toBe("");
	expect(h.voice.takeAudio(id, 0)).toEqual(wav());
	source.push("続けましょう");
	source.finish();
	await until(() => h.voice.get(id)?.status === "ready");
	expect(h.dialogue.get(runId)?.status).toBe("completed");
	expect(h.voice.takeAudio(id, 0)).toEqual(wav());
	expect(states.map((state) => state.current_chunk)).toEqual([
		"よかった、",
		"大変でしたね。",
		"続けましょう",
	]);
	expect(states[1]?.response).toBe("よかった、大変でしたね。");
	expect(states[0]?.conversation).toContain("話してください。");
	expect(h.voice.get(id)?.audioChunks.map((chunk) => chunk.delivery)).toEqual([
		expect.objectContaining({
			source: "scored",
			emotion: "joy",
			motion: "joyful",
			tone: "excited",
		}),
		expect.objectContaining({
			source: "scored",
			emotion: "empathy",
			motion: "listening",
			tone: "gentle",
		}),
		expect.objectContaining({
			source: "scored",
			emotion: "empathy",
			motion: "listening",
			tone: "gentle",
		}),
	]);
	expect(options[0]?.intonationScale).toBeCloseTo(1.45);
	expect(options[1]?.intonationScale).toBeCloseTo(0.75);
	expect(events).toEqual([
		"judge:よかった、",
		"tts:よかった、",
		"judge:大変でしたね。",
		"tts:大変でしたね。",
		"judge:続けましょう",
		"tts:続けましょう",
	]);
});

for (const stage of ["judge", "tts"] as const)
	test(`cancelling during ${stage} aborts the clause and discards late results and queued clauses`, async () => {
		const source = stream(),
			late = gate<void>();
		let judging = 0,
			speaking = 0,
			active: AbortSignal | undefined;
		const h = await setup(undefined, {
			transcribe: async () => "話してください。",
			answerStream: source.answerStream,
			judge: async (_state, _questions, signal) => {
				judging++;
				if (stage === "judge") {
					active = signal;
					await late.promise;
				}
				return ruri("joy");
			},
			speak: async (_text, signal) => {
				speaking++;
				if (stage === "tts") {
					active = signal;
					await late.promise;
				}
				return wav();
			},
		});
		const id = await start(h, source);
		source.push("先の句。後ろの句。");
		await until(() => !!active);
		expect(h.dialogue.get(h.voice.get(id)!.runId!)?.status).toBe("running");
		await h.voice.cancel(id);
		expect(active?.aborted).toBe(true);
		expect(source.signal?.aborted).toBe(true);
		late.resolve();
		expect(() => source.push("取消後の本文。")).toThrow();
		source.finish();
		await until(() =>
			h.inference.usage().every((attempt) => attempt.status !== "running"),
		);
		await settle();
		expect(h.voice.get(id)?.status).toBe("cancelled");
		expect(h.voice.get(id)?.audioChunks).toEqual([]);
		expect(h.voice.takeAudio(id, 0)).toBeNull();
		expect(
			h.conversation
				.get("main")
				.messages.filter((message) => message.role === "assistant")
				.map((message) => message.text),
		).toEqual([]);
		expect(judging).toBe(1);
		expect(speaking).toBe(stage === "judge" ? 0 : 1);
		expect(
			h.inference
				.usage()
				.filter((attempt) => attempt.purpose === "tts" && attempt.accepted),
		).toEqual([]);
	});

test("cancelling after playback during generation discards ready and queued clauses", async () => {
	const source = stream();
	const spoken: string[] = [];
	const h = await setup(undefined, {
		transcribe: async () => "数えてください。",
		answerStream: source.answerStream,
		speak: async (text) => {
			spoken.push(text);
			return wav();
		},
	});
	const id = await start(h, source);
	source.push("一。二。三。四。");
	await until(() => h.voice.get(id)?.audioChunks.length === 3);
	expect(h.dialogue.get(h.voice.get(id)!.runId!)?.status).toBe("running");
	await h.voice.played(id, 0);
	await until(() => spoken.length === 4);
	await h.voice.cancel(id);
	expect(h.voice.get(id)?.status).toBe("cancelled");
	expect(h.voice.get(id)?.audioChunks).toEqual([]);
	for (const index of [0, 1, 2, 3])
		expect(h.voice.takeAudio(id, index)).toBeNull();
	source.finish();
	await settle();
	expect(spoken).toEqual(["一。", "二。", "三。", "四。"]);
	expect(h.voice.get(id)?.audioChunks).toEqual([]);
});

test("clauses played before generation ends are recorded as heard once the answer is adopted", async () => {
	const source = stream();
	const h = await setup(undefined, {
		transcribe: async () => "数えてください。",
		answerStream: source.answerStream,
		speak: async () => wav(),
	});
	const id = await start(h, source);
	source.push("一。二。");
	await until(() => h.voice.get(id)?.audioChunks.length === 2);
	await h.voice.played(id, 0);
	await h.voice.played(id, 1);
	expect(h.voice.get(id)?.status).toBe("responding");
	expect(h.dialogue.answerText(h.voice.get(id)!.runId!)).toBeNull();
	source.finish();
	await until(() => h.voice.get(id)?.status === "played");
	const delivered = h.store.read((db) =>
		createContinuityService(h.store)
			.events.logInTransaction(db, "main")
			.filter((event) => event.type === "delivered")
			.map((event) => JSON.parse(event.text ?? "{}")),
	);
	expect(delivered).toEqual([expect.objectContaining({ heard: "full" })]);
});

test("correcting the source while generating aborts queued speech and discards a late TTS result", async () => {
	const source = stream(),
		late = gate<void>();
	let speaking: AbortSignal | undefined;
	const h = await setup(undefined, {
		transcribe: async () => "最初の依頼。",
		answerStream: source.answerStream,
		speak: async (_text, signal) => {
			speaking = signal;
			await late.promise;
			return wav();
		},
	});
	const id = await start(h, source);
	source.push("最初の句。後続の句。");
	await until(() => !!speaking);
	const user = h.conversation
		.get("main")
		.messages.find((m) => m.role === "user")!;
	await h.conversation.correct({ messageId: user.id, text: "訂正した依頼。" });
	await until(() => h.voice.get(id)?.status === "failed");
	expect(speaking?.aborted).toBe(true);
	expect(source.signal?.aborted).toBe(true);
	late.resolve();
	source.finish();
	await settle();
	expect(h.voice.get(id)?.audioChunks).toEqual([]);
	expect(h.voice.takeAudio(id, 0)).toBeNull();
	expect(h.dialogue.answerText(h.voice.get(id)!.runId!)).toBeNull();
});

test("a failed generation discards ready audio without mixing a fallback answer into it", async () => {
	const source = stream();
	const h = await setup(undefined, {
		transcribe: async () => "話してください。",
		answerStream: source.answerStream,
		speak: async () => wav(),
	});
	const id = await start(h, source);
	source.push("先に届いた句。");
	await until(() => h.voice.get(id)?.audioChunks.length === 1);
	source.fail(new Error("network_unavailable"));
	await until(() => h.voice.get(id)?.status === "failed");
	expect(h.voice.get(id)?.audioChunks).toEqual([]);
	expect(h.voice.takeAudio(id, 0)).toBeNull();
	expect(h.dialogue.answerText(h.voice.get(id)!.runId!)).toBeNull();
	expect(h.calls).toEqual([]);
});

test("a failure to read the generation's speech context fails speech instead of being swallowed", async () => {
	const source = stream();
	let spoken = 0,
		contexts = 0;
	const h = await setup(undefined, {
		transcribe: async () => "話してください。",
		answerStream: source.answerStream,
		speak: async () => {
			spoken++;
			return wav();
		},
	});
	const readContext = h.dialogue.answerContext;
	h.dialogue.answerContext = (runId) => {
		if (++contexts === 2) throw new Error("speech_context_unavailable");
		return readContext(runId);
	};
	const id = await start(h, source);
	try {
		await until(() => h.voice.get(id)?.status === "failed");
		expect(h.voice.get(id)?.error).toBe("speech_context_unavailable");
		expect(h.voice.get(id)?.audioChunks).toEqual([]);
		expect(spoken).toBe(0);
	} finally {
		source.finish();
	}
});

test("a rejected clause decision does not prevent the next clause from being judged and expressed", async () => {
	const source = stream();
	let judgments = 0;
	const h = await setup(undefined, {
		transcribe: async () => "話してください。",
		answerStream: source.answerStream,
		judge: async () => ruri("joy", ++judgments === 1 ? 0.5 : 0.9),
		speak: async () => wav(),
	});
	const id = await start(h, source);
	source.push("最初。次。");
	source.finish();
	await until(() => h.voice.get(id)?.status === "ready");
	expect(h.voice.get(id)?.audioChunks.map((chunk) => chunk.delivery)).toEqual([
		expect.objectContaining({
			source: "fallback",
			reason: "low-confidence",
			motion: "neutral",
		}),
		expect.objectContaining({
			source: "scored",
			emotion: "joy",
			motion: "joyful",
		}),
	]);
	expect(judgments).toBe(2);
});

test("URLs and source lines remain on screen but never reach the speech judge or TTS, including split URL tokens", async () => {
	const source = stream(),
		spoken: string[] = [],
		judged: string[] = [];
	const h = await setup(undefined, {
		transcribe: async () => "話してください。",
		answerStream: source.answerStream,
		judge: async (state) => {
			judged.push(state.current_chunk!);
			return ruri("none");
		},
		speak: async (text) => {
			spoken.push(text);
			return wav();
		},
	});
	const id = await start(h, source);
	const answer =
		"本文です。\n出典：[example.com](https://example.com/report)\nhttps://example.com/a.b を表示します。";
	for (const char of answer) source.push(char);
	source.finish();
	await until(() => h.voice.get(id)?.status === "ready");
	expect(spoken).toEqual(["本文です。"]);
	expect(judged).toEqual(spoken);
	expect(h.dialogue.answerText(h.voice.get(id)!.runId!)).toBe(answer);
});
