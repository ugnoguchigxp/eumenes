import type { LarmPort } from "../../larm";
import { withVoiceAuthority } from "./voice-fixture";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	openStore,
	orderMigrations,
	type SqliteStore,
} from "../../../infrastructure/sqlite";
import {
	createConversationService,
	migrations as conversationMigrations,
} from "../../conversation";
import {
	createContinuityService,
	migrations as continuityMigrations,
} from "../../continuity";
import {
	createDialogueService,
	migrations as dialogueMigrations,
} from "../../dialogue";
import { createQueue, migrations as queueMigrations } from "../../queue";
import { createVoiceDialogue, migrations as voiceMigrations } from "..";
import { SpeechSentences } from "../service/sentences";
import { Hono } from "hono";
import { registerVoiceDialogue } from "..";
import type { InferencePort } from "../../inference";
import { hostDelivery, type SpeechPreparation } from "../../delivery";
import { testConversationAgent } from "./conversation-agent.fixture";

/** The schema the dialogue and voice flow need, built from each domain's own migrations. */
const schemaMigrations = () =>
	orderMigrations([
		...conversationMigrations,
		...queueMigrations,
		...continuityMigrations,
		...dialogueMigrations,
		...voiceMigrations,
	]);

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Sends a transcribed input, as the Web does when the speaker is idle. */
async function commitWhenReady(
	voice: ReturnType<typeof createVoiceDialogue>,
	id: string,
) {
	for (let i = 0; i < 200 && voice.get(id)?.status === "recognizing"; i++)
		await pause(10);
	const turn = voice.get(id);
	if (turn?.status === "input_ready") await voice.commit(id, turn.revision);
}
const wav = (() => {
	const b = new Uint8Array(44);
	b.set(new TextEncoder().encode("RIFF"), 0);
	b.set(new TextEncoder().encode("WAVE"), 8);
	return b;
})();

test("voice capture to ASR, dialogue, TTS; duplicate utterance is ignored", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-voice-"));
	let asr = 0,
		llm = 0,
		tts = 0;
	const larm = withVoiceAuthority({
		status: () => ({ state: "ready", capabilities: ["llm", "asr", "tts"] }),
		connect: async () => {},
		answer: async () => {
			llm++;
			return "今日は晴れです";
		},
		transcribe: async () => {
			asr++;
			return "今日の天気は";
		},
		speak: async () => {
			tts++;
			return wav;
		},
		close: async () => {},
	});
	try {
		const store = openStore(join(dir, "db.sqlite3"), schemaMigrations());
		const conversation = createConversationService(store);
		const queue = createQueue(store);
		queue.start();
		const dialogue = createDialogueService({
			conversationAgent: testConversationAgent,
			store,
			continuity: createContinuityService(store),
			conversation,
			larm,
			queue,
		});
		let failNextWrite = false;
		const voiceStore: SqliteStore = {
			onCommit: (listener) => store.onCommit(listener),
			read: (operation) => store.read(operation),
			readSnapshot: (operation) => store.readSnapshot(operation),
			write: (operation) =>
				failNextWrite
					? ((failNextWrite = false),
						Promise.reject(new Error("disk_write_failed")))
					: store.write(operation),
			close: () => store.close(),
		};
		const voice = createVoiceDialogue(voiceStore, dialogue, larm);
		const sessionId = crypto.randomUUID(),
			utteranceId = crypto.randomUUID();
		voice.start(sessionId, 1);
		const first = await voice.accept(sessionId, 1, 1, utteranceId, wav);
		const duplicate = await voice.accept(sessionId, 1, 1, utteranceId, wav);
		expect(duplicate.utteranceId).toBe(first.utteranceId);
		expect(duplicate.sequence).toBe(1);
		await expect(
			voice.accept(sessionId, 1, 3, crypto.randomUUID(), wav),
		).rejects.toThrow("voice_sequence_out_of_order");
		await expect(
			voice.accept(sessionId, 1, 2, utteranceId, wav),
		).rejects.toThrow("voice_utterance_conflict");
		await commitWhenReady(voice, utteranceId);
		for (let i = 0; i < 100 && voice.get(utteranceId)?.status !== "ready"; i++)
			await pause(20);
		expect(voice.get(utteranceId)?.status).toBe("ready");
		expect(voice.takeAudio(utteranceId)).toEqual(wav);
		expect([asr, llm, tts]).toEqual([1, 1, 1]);
		const linked = voice.get(utteranceId);
		const [run] = dialogue.list("main");
		expect(linked?.runId).toBe(run?.id);
		expect(run?.utteranceId).toBe(utteranceId);
		expect(conversation.get("main").messages.map((m) => m.text)).toEqual([
			"今日の天気は",
			"今日は晴れです",
		]);
		failNextWrite = true;
		await expect(voice.played(utteranceId)).rejects.toThrow(
			"disk_write_failed",
		);
		expect(voice.get(utteranceId)?.status).toBe("ready");
		expect(voice.takeAudio(utteranceId)).toEqual(wav);
		await voice.played(utteranceId);
		expect(voice.takeAudio(utteranceId)).toBeNull();
		await voice.stop(sessionId, 1);
		await queue.close(100);
		await store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("restart cancels the run of a stale voice turn so no old answer is spoken", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-voice-recover-"));
	const larm = withVoiceAuthority({
		status: () => ({ state: "ready", capabilities: ["llm", "asr", "tts"] }),
		connect: async () => {},
		answer: () => new Promise(() => {}),
		transcribe: async () => "質問",
		speak: async () => wav,
		close: async () => {},
	});
	try {
		const store = openStore(join(dir, "db.sqlite3"), schemaMigrations());
		const conversation = createConversationService(store);
		const queue = createQueue(store);
		const dialogue = createDialogueService({
			conversationAgent: testConversationAgent,
			store,
			continuity: createContinuityService(store),
			conversation,
			larm,
			queue,
		});
		const voice = createVoiceDialogue(store, dialogue, larm);
		const sessionId = crypto.randomUUID();
		const utteranceId = crypto.randomUUID();
		voice.start(sessionId, 1);
		await voice.accept(sessionId, 1, 1, utteranceId, wav);
		await commitWhenReady(voice, utteranceId);
		for (let i = 0; i < 100 && !voice.get(utteranceId)?.runId; i++)
			await pause(10);
		const runId = voice.get(utteranceId)?.runId as string;
		expect(dialogue.get(runId)?.status).toBe("queued");
		const queue2 = createQueue(store);
		const dialogue2 = createDialogueService({
			conversationAgent: testConversationAgent,
			store,
			continuity: createContinuityService(store),
			conversation,
			larm,
			queue: queue2,
		});
		const voice2 = createVoiceDialogue(store, dialogue2, larm);
		await voice2.recover();
		await dialogue2.recover();
		await queue2.recover();
		expect(voice2.get(utteranceId)?.status).toBe("interrupted");
		expect(dialogue2.get(runId)?.status).toBe("cancelled");
		expect(queue2.get(dialogue2.get(runId)?.jobId ?? "")?.state).toBe(
			"cancelled",
		);
		await voice.close();
		await store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

async function evictionHarness(
	options: {
		prepared?: AbortSignal[];
		/** What the run's waits return first (then completed), and the cancels they caused. */
		waits?: Array<{
			status: string;
			deadlineAt: string | null;
			answerMessageId?: string | null;
		}>;
		cancelled?: string[];
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-voice-evict-"));
	const store = openStore(join(dir, "db.sqlite3"), schemaMigrations());
	const dialogue = {
		submitVoice: async (
			_input: unknown,
			_subject: unknown,
			_validation: unknown,
			link: (db: unknown, run: unknown) => void,
		) => {
			const run = { id: crypto.randomUUID(), deadlineAt: null };
			await store.write((db) => link(db, run));
			return run;
		},
		get: () => ({ status: "completed" }),
		subscribeProgress: () => () => {},
		subscribeAnswerStream: () => () => {},
		waitForTerminal: async () =>
			options.waits?.shift() ?? {
				status: "completed",
				answerMessageId: "answer",
			},
		answerText: () => "回答",
		recordHeardInTransaction: () => {},
		cancel: async (runId: string) => {
			options.cancelled?.push(runId);
			return null;
		},
		stopReply: async (runId: string) => {
			options.cancelled?.push(runId);
			return null;
		},
	} as unknown as ReturnType<typeof createDialogueService>;
	const larm = withVoiceAuthority({
		status: () => ({ state: "ready", capabilities: ["llm", "asr", "tts"] }),
		connect: async () => {},
		answer: async () => "回答",
		transcribe: async () => "質問",
		speak: async () => wav,
		prepareVoice: async (signal: AbortSignal) => {
			options.prepared?.push(signal);
		},
		close: async () => {},
	});
	let now = Date.parse("2026-10-10T00:00:00.000Z");
	const voice = createVoiceDialogue(store, dialogue, larm, () =>
		new Date(now).toISOString(),
	);
	const ids: string[] = [];
	async function turn(
		sessionId: string,
		sequence: number,
		status: "ready" | "failed" | "played",
	) {
		const id = crypto.randomUUID();
		ids.push(id);
		await voice.accept(sessionId, 1, sequence, id, wav);
		await commitWhenReady(voice, id);
		for (let i = 0; i < 200 && voice.get(id)?.status !== status; i++)
			await pause(10);
		expect(voice.get(id)?.status).toBe(status);
		return id;
	}
	return {
		voice,
		turn,
		ids,
		advance: (ms: number) => {
			now += ms;
		},
		dispose: async () => {
			await voice.close();
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("a run whose deadline moved later meanwhile (a toolchain's own run time) is waited for, not cancelled", async () => {
	const cancelled: string[] = [];
	const later = new Date(Date.now() + 20 * 60_000).toISOString();
	const h = await evictionHarness({
		waits: [
			{ status: "running", deadlineAt: later },
			{ status: "running", deadlineAt: later },
		],
		cancelled,
	});
	try {
		const sessionId = crypto.randomUUID();
		h.voice.start(sessionId, 1);
		await h.turn(sessionId, 1, "ready");
		expect(cancelled).toEqual([]);
	} finally {
		await h.dispose();
	}
});

test("a run that chose not to speak ends the turn quietly, not as a failure", async () => {
	const h = await evictionHarness({
		waits: [{ status: "completed", deadlineAt: null, answerMessageId: null }],
	});
	try {
		const sessionId = crypto.randomUUID();
		h.voice.start(sessionId, 1);
		const id = await h.turn(sessionId, 1, "played");
		expect(h.voice.get(id)?.error ?? null).toBeNull();
	} finally {
		await h.dispose();
	}
});

test("a waiting ready turn is never evicted; the ninth is refused", async () => {
	const h = await evictionHarness();
	try {
		const sessionId = crypto.randomUUID();
		h.voice.start(sessionId, 1);
		for (let n = 1; n <= 8; n++) await h.turn(sessionId, n, "ready");
		const ninth = await h.turn(sessionId, 9, "failed");
		expect(h.voice.get(h.ids[0] as string)?.status).toBe("ready");
		expect(h.voice.get(ninth)?.error).toBe("voice_audio_capacity");
	} finally {
		await h.dispose();
	}
});

test("a waiting turn older than ten minutes is evicted to make room", async () => {
	const h = await evictionHarness();
	try {
		const sessionId = crypto.randomUUID();
		h.voice.start(sessionId, 1);
		for (let n = 1; n <= 8; n++) await h.turn(sessionId, n, "ready");
		h.advance(601_000);
		const ninth = await h.turn(sessionId, 9, "ready");
		const first = h.ids[0] as string;
		for (let i = 0; i < 200 && h.voice.get(first)?.status !== "failed"; i++)
			await pause(10);
		expect(h.voice.get(first)?.status).toBe("failed");
		expect(h.voice.get(first)?.error).toBe("audio_evicted");
		expect(h.voice.get(ninth)?.status).toBe("ready");
	} finally {
		await h.dispose();
	}
});

test("a fully played turn frees its slot without failing any turn", async () => {
	const h = await evictionHarness();
	try {
		const sessionId = crypto.randomUUID();
		h.voice.start(sessionId, 1);
		for (let n = 1; n <= 8; n++) await h.turn(sessionId, n, "ready");
		const first = h.ids[0] as string;
		for (const chunk of h.voice.get(first)?.audioChunks ?? [])
			await h.voice.played(first, chunk.index);
		expect(h.voice.get(first)?.status).toBe("played");
		await h.turn(sessionId, 9, "ready");
		for (const id of h.ids)
			expect(["played", "ready"]).toContain(h.voice.get(id)?.status as string);
	} finally {
		await h.dispose();
	}
});

test("a session idle for over 30 minutes is dropped on the next session start", async () => {
	const h = await evictionHarness();
	try {
		const s = crypto.randomUUID(),
			t = crypto.randomUUID();
		h.voice.start(s, 1);
		h.advance(31 * 60_000);
		h.voice.start(t, 1);
		await expect(
			h.voice.accept(s, 1, 1, crypto.randomUUID(), wav),
		).rejects.toThrow("voice_session_inactive");
	} finally {
		await h.dispose();
	}
});

test("restarting a session aborts the previous warm-up", async () => {
	const prepared: AbortSignal[] = [];
	const h = await evictionHarness({ prepared });
	try {
		const s = crypto.randomUUID();
		h.voice.start(s, 1);
		h.voice.start(s, 2);
		expect(prepared).toHaveLength(2);
		expect(prepared[0]?.aborted).toBe(true);
		expect(prepared[1]?.aborted).toBe(false);
	} finally {
		await h.dispose();
	}
});

test("stopping a session fences acceptance waiting in the writer queue", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-voice-stop-"));
	const store = openStore(join(dir, "db.sqlite3"), schemaMigrations());
	let asr = 0;
	const larm = withVoiceAuthority({
		status: () => ({ state: "ready", capabilities: ["asr"] }),
		connect: async () => {},
		answer: async () => "answer",
		transcribe: async () => {
			asr++;
			return "text";
		},
		speak: async () => wav,
		close: async () => {},
	});
	const voice = createVoiceDialogue(
		store,
		{} as ReturnType<typeof createDialogueService>,
		larm,
	);
	try {
		const session = crypto.randomUUID(),
			id = crypto.randomUUID();
		voice.start(session, 1);
		const accepted = voice.accept(session, 1, 1, id, wav);
		const outcome = accepted.then(
			() => null,
			(error: Error) => error,
		);
		await voice.stop(session, 1);
		expect((await outcome)?.message).toBe("voice_session_inactive");
		expect(voice.get(id)).toBeNull();
		expect(asr).toBe(0);
	} finally {
		await voice.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("replay splits finished text into clauses and synthesizes on demand", async () => {
	const spoken: string[] = [];
	const dir = mkdtempSync(join(tmpdir(), "eumenes-replay-"));
	const store = openStore(join(dir, "db.sqlite3"), []);
	const voice = createVoiceDialogue(
		store,
		{} as never,
		{
			speak: async (text: string) => {
				spoken.push(text);
				return wav;
			},
		} as unknown as LarmPort,
	);
	try {
		expect(voice.replaySentences("今日は晴れです。明日は雨です。")).toEqual([
			"今日は晴れです。",
			"明日は雨です。",
		]);
		expect(
			voice.replaySentences(
				"調べました。晴れ、最高26度、最低17度、降水確率0％です。\n\nソース：[tenki.jp](https://tenki.jp/forecast/3/17/4610/14204/)",
			),
		).toEqual([
			"調べました。",
			"晴れ、",
			"最高26度、",
			"最低17度、",
			"降水確率0％です。",
		]);
		await voice.replayAudio("今日は晴れです。", new AbortController().signal);
		expect(spoken).toEqual(["今日は晴れです。"]);
		await expect(
			voice.replayAudio("あ".repeat(401), new AbortController().signal),
		).rejects.toThrow("replay_text_invalid");
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("replay HTTP returns the adopted Laya motion with the same audio and supports legacy adapters", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-replay-motion-"));
	const store = openStore(join(dir, "db.sqlite3"), []);
	let synthesis = 0;
	const port: InferencePort = {
		status: () => ({ state: "ready", capabilities: ["tts"] }),
		answer: async () => {
			throw new Error("unexpected_answer");
		},
		transcribe: async () => {
			throw new Error("unexpected_transcribe");
		},
		close: async () => {},
		speak: async () => {
			synthesis++;
			return wav;
		},
		speakWithDelivery: async () => {
			synthesis++;
			return {
				wav,
				delivery: {
					id: crypto.randomUUID(),
					motion: "joyful",
					tone: "bright",
					source: "system-one",
					confidence: 0.9,
					latencyMs: 10,
				},
			};
		},
	};
	const service = createVoiceDialogue(store, {} as never, port);
	const app = new Hono();
	registerVoiceDialogue(app, service);
	const request = () =>
		app.request("/api/voice/replay/audio", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "よかったですね。" }),
		});
	try {
		const response = await request();
		expect(response.status).toBe(200);
		expect(response.headers.get("X-Avatar-Motion")).toBe("joyful");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(wav);
		expect(synthesis).toBe(1);
		delete port.speakWithDelivery;
		const legacy = await request();
		expect(legacy.status).toBe(200);
		expect(legacy.headers.get("X-Avatar-Motion")).toBeNull();
		expect(synthesis).toBe(2);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a runless message's host delivery reaches synthesis only for a clause of that message", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-replay-host-"));
	const store = openStore(join(dir, "db.sqlite3"), []);
	const prepared: Array<SpeechPreparation | undefined> = [];
	const port: InferencePort = {
		status: () => ({ state: "ready", capabilities: ["tts"] }),
		answer: async () => {
			throw new Error("unexpected_answer");
		},
		transcribe: async () => {
			throw new Error("unexpected_transcribe");
		},
		close: async () => {},
		speak: async () => wav,
		speakWithDelivery: async (_text, _signal, preparation) => {
			prepared.push(preparation);
			return {
				wav,
				...(preparation?.delivery ? { delivery: preparation.delivery } : {}),
			};
		},
	};
	const own = hostDelivery("sadness");
	const dialogue = {
		hostMessageDelivery: (id: string) =>
			id === "agency:s1:t1"
				? { text: "そっか。つらかったね。", delivery: own }
				: null,
	};
	const service = createVoiceDialogue(store, dialogue as never, port);
	try {
		const a = await service.replaySpeech(
			"そっか。",
			AbortSignal.timeout(5000),
			undefined,
			"agency:s1:t1",
		);
		expect(prepared[0]?.delivery).toEqual(own);
		expect(prepared[0]?.deliveryScope).toBe("chunk");
		expect(a.delivery?.motion).toBe("downcast");
		await service.replaySpeech(
			"別の文。",
			AbortSignal.timeout(5000),
			undefined,
			"agency:s1:t1",
		);
		await service.replaySpeech(
			"そっか。",
			AbortSignal.timeout(5000),
			undefined,
			"agency:other",
		);
		expect(prepared[1]?.delivery).toBeUndefined();
		expect(prepared[2]?.delivery).toBeUndefined();
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test.each([
	["larm_inference_500", 3],
	["workers_ai_http_400", 1],
	["larm_inference_422", 1],
	["network_unavailable", 3],
] as const)(
	"a failed clause (%s) is skipped after %i attempts and the rest is spoken",
	async (code, attempts) => {
		const dir = mkdtempSync(join(tmpdir(), "eumenes-voice-skip-"));
		try {
			const store = openStore(join(dir, "db.sqlite3"), schemaMigrations());
			const dialogue = {
				submitVoice: async (
					_input: unknown,
					_subject: unknown,
					_validation: unknown,
					link: (db: unknown, run: unknown) => void,
				) => {
					const run = { id: crypto.randomUUID(), deadlineAt: null };
					await store.write((db) => link(db, run));
					return run;
				},
				get: () => ({ status: "completed" }),
				subscribeProgress: () => () => {},
				subscribeAnswerStream: () => () => {},
				waitForTerminal: async () => ({
					status: "completed",
					answerMessageId: "answer",
				}),
				answerText: () => "最初です。壊れます。最後です。",
				cancel: async () => null,
				stopReply: async () => null,
			} as unknown as ReturnType<typeof createDialogueService>;
			const calls: string[] = [];
			const larm = withVoiceAuthority({
				status: () => ({ state: "ready", capabilities: ["llm", "asr", "tts"] }),
				connect: async () => {},
				answer: async () => "回答",
				transcribe: async () => "質問",
				speak: async (text) => {
					calls.push(text);
					if (text.includes("壊れ")) throw new Error(code);
					return wav;
				},
				close: async () => {},
			});
			const voice = createVoiceDialogue(store, dialogue, larm);
			const sessionId = crypto.randomUUID(),
				utteranceId = crypto.randomUUID();
			voice.start(sessionId, 1);
			await voice.accept(sessionId, 1, 1, utteranceId, wav);
			await commitWhenReady(voice, utteranceId);
			for (
				let i = 0;
				i < 100 && voice.get(utteranceId)?.status !== "ready";
				i++
			)
				await pause(20);
			expect(voice.get(utteranceId)?.status).toBe("ready");
			expect(calls.filter((t) => t.includes("壊れ"))).toHaveLength(attempts);
			expect(voice.get(utteranceId)?.audioChunks.map((c) => c.text)).toEqual([
				"最初です。",
				"最後です。",
			]);
			expect(voice.get(utteranceId)?.audioSkipped).toBe(1);
			await voice.close();
			await store.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

test("clauses without any phoneme are never sent to TTS", () => {
	expect(new SpeechSentences().append("はい。…。！？ 次です。", true)).toEqual([
		"はい。",
		"次です。",
	]);
});

test("a failed turn stores only a machine-readable error code", async () => {
	for (const [thrown, expected] of [
		["connect ECONNREFUSED 192.168.0.2:9810", "voice_failed"],
		["audio_size_invalid", "audio_size_invalid"],
	] as const) {
		const dir = mkdtempSync(join(tmpdir(), "eumenes-voice-error-"));
		const store = openStore(join(dir, "db.sqlite3"), schemaMigrations());
		const larm = withVoiceAuthority({
			status: () => ({ state: "ready", capabilities: ["asr"] }),
			connect: async () => {},
			transcribe: async () => {
				throw new Error(thrown);
			},
			close: async () => {},
		} as unknown as LarmPort);
		const voice = createVoiceDialogue(
			store,
			{} as ReturnType<typeof createDialogueService>,
			larm,
		);
		try {
			const session = crypto.randomUUID(),
				id = crypto.randomUUID();
			voice.start(session, 1);
			await voice.accept(session, 1, 1, id, wav);
			for (let i = 0; i < 100 && voice.get(id)?.status !== "failed"; i++)
				await pause(20);
			expect(voice.get(id)?.status).toBe("failed");
			expect(voice.get(id)?.error).toBe(expected);
		} finally {
			await voice.close();
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

async function raceFixture(prefix: string) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	const base = withVoiceAuthority({
		status: () => ({ state: "ready", capabilities: ["llm", "asr", "tts"] }),
		connect: async () => {},
		answer: async () => "回答",
		transcribe: async () => "質問",
		speak: async () => wav,
		close: async () => {},
	});
	const larm = base;
	const store = openStore(join(dir, "db.sqlite3"), schemaMigrations());
	const conversation = createConversationService(store);
	const queue = createQueue(store);
	queue.start();
	const dialogue = createDialogueService({
		conversationAgent: testConversationAgent,
		store,
		conversation,
		continuity: createContinuityService(store),
		larm,
		queue,
	});
	return {
		dir,
		store,
		queue,
		conversation,
		dialogue,
		larm,
		base,
		async close() {
			await queue.close(100);
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("linking a run to a cancelled turn rolls the run back", async () => {
	const f = await raceFixture("eumenes-voice-race-b-");
	let voice!: ReturnType<typeof createVoiceDialogue>;
	let cancelling: Promise<unknown> | undefined;
	const id = crypto.randomUUID();
	const racing = Object.create(f.dialogue) as typeof f.dialogue;
	racing.submitVoice = (...args) => {
		// The cancel write is queued ahead of the accept write, as in the reported race.
		cancelling = voice.cancel(id);
		return f.dialogue.submitVoice(...args);
	};
	voice = createVoiceDialogue(f.store, racing, f.larm);
	try {
		const sessionId = crypto.randomUUID();
		voice.start(sessionId, 1);
		await voice.accept(sessionId, 1, 1, id, wav);
		await commitWhenReady(voice, id);
		for (let i = 0; i < 100 && !cancelling; i++) await pause(10);
		await cancelling;
		await pause(50);
		expect(voice.get(id)?.status).toBe("cancelled");
		expect(f.dialogue.list("main").length).toBe(0);
		expect(f.conversation.get("main").messages.length).toBe(0);
	} finally {
		await voice.close();
		await f.close();
	}
});
