import { expect, test } from "bun:test";
import type { LarmCallOptions, LarmPort } from "../../larm";
import { emotionSchema, type Emotion } from "../../delivery";
import { settle } from "../../../infrastructure/wait-for";
import { setup, say, until, wav } from "./settings-voice.fixture";

function gate<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
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

test("validated short answers keep clause-specific tone without speaking provisional text", async () => {
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
	await settle();
	expect(states).toHaveLength(0);
	expect(h.voice.get(id)?.audioChunks).toEqual([]);
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
	expect(states[1]?.response).toBe("よかった、大変でしたね。続けましょう");
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
		source.finish();
		await until(() => !!active);
		await h.voice.cancel(id);
		expect(active?.aborted).toBe(true);
		late.resolve();
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
		).toEqual(["先の句。後ろの句。"]);
		expect(judging).toBe(1);
		expect(speaking).toBe(stage === "judge" ? 0 : 1);
		expect(
			h.inference
				.usage()
				.filter((attempt) => attempt.purpose === "tts" && attempt.accepted),
		).toEqual([]);
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

test("forgetting a goal revokes provisional text before any speech judgment or audio", async () => {
	const source = stream(),
		late = gate<void>();
	let judging: AbortSignal | undefined,
		spoken = 0;
	const h = await setup(
		undefined,
		{
			transcribe: async () => "話してください。",
			answerStream: source.answerStream,
			judge: async (_state, _questions, signal) => {
				judging = signal;
				await late.promise;
				return ruri("joy");
			},
			speak: async () => {
				spoken++;
				return wav();
			},
		},
		{
			adoptedForContextInTransaction: () => [
				{
					goalId: "goal",
					priority: 1,
					desiredState: "会話を続ける",
					revision: 1,
				},
			],
			existingInTransaction: (db) =>
				new Set(
					db
						.query("SELECT id FROM streaming_goals")
						.all()
						.map((row) => (row as { id: string }).id),
				),
		},
	);
	await h.store.write((db) => {
		db.exec("CREATE TABLE streaming_goals (id TEXT PRIMARY KEY)");
		db.query("INSERT INTO streaming_goals (id) VALUES (?)").run("goal");
	});
	const id = await start(h, source);
	source.push("最初の句。");
	await settle();
	expect(judging).toBeUndefined();
	expect(h.dialogue.get(h.voice.get(id)!.runId!)?.status).toBe("running");
	await h.store.write((db) => db.query("DELETE FROM streaming_goals").run());
	await until(() => h.voice.get(id)?.status === "failed");
	expect(source.signal?.aborted).toBe(true);
	expect(judging).toBeUndefined();
	late.resolve();
	source.finish();
	await settle();
	expect(spoken).toBe(0);
	expect(h.voice.get(id)?.audioChunks).toEqual([]);
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
