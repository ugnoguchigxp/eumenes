import type { LarmPort } from "../../larm";
import { withLanguageControl } from "./control-fixture";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import {
	migration as conversationMigration,
	avatarMotionMigration as conversationAvatarMotionMigration,
	answerDeliveryMigration as conversationAnswerDeliveryMigration,
	createConversationService,
} from "../../conversation";
import {
	createDialogueService,
	migration as dialogueMigration,
	queueLinkMigration,
} from "../../dialogue";
import { createQueue, migration as queueMigration } from "../../queue";
import { createVoiceDialogue, migration, sequenceMigration } from "..";
import { SpeechSentences } from "../service/sentences";
import { Hono } from "hono";
import { registerVoiceDialogue } from "..";
import type { InferencePort } from "../../inference";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
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
	const larm = withLanguageControl({
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
		const store = openStore(join(dir, "db.sqlite3"), [
			conversationMigration,
			conversationAvatarMotionMigration,
			conversationAnswerDeliveryMigration,
			dialogueMigration,
			migration,
			queueMigration,
			queueLinkMigration,
			sequenceMigration,
		]);
		const conversation = createConversationService(store);
		const queue = createQueue(store);
		queue.start();
		const dialogue = createDialogueService({
			store,
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
	const larm = withLanguageControl({
		status: () => ({ state: "ready", capabilities: ["llm", "asr", "tts"] }),
		connect: async () => {},
		answer: () => new Promise(() => {}),
		transcribe: async () => "質問",
		speak: async () => wav,
		close: async () => {},
	});
	try {
		const store = openStore(join(dir, "db.sqlite3"), [
			conversationMigration,
			conversationAvatarMotionMigration,
			conversationAnswerDeliveryMigration,
			dialogueMigration,
			migration,
			queueMigration,
			queueLinkMigration,
			sequenceMigration,
		]);
		const conversation = createConversationService(store);
		const queue = createQueue(store);
		const dialogue = createDialogueService({
			store,
			conversation,
			larm,
			queue,
		});
		const voice = createVoiceDialogue(store, dialogue, larm);
		const sessionId = crypto.randomUUID();
		const utteranceId = crypto.randomUUID();
		voice.start(sessionId, 1);
		await voice.accept(sessionId, 1, 1, utteranceId, wav);
		for (let i = 0; i < 100 && !voice.get(utteranceId)?.runId; i++)
			await pause(10);
		const runId = voice.get(utteranceId)?.runId as string;
		expect(dialogue.get(runId)?.status).toBe("queued");
		const queue2 = createQueue(store);
		const dialogue2 = createDialogueService({
			store,
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

async function evictionHarness(options: { prepared?: AbortSignal[] } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-voice-evict-"));
	const store = openStore(join(dir, "db.sqlite3"), [
		migration,
		sequenceMigration,
	]);
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
		waitForTerminal: async () => ({
			status: "completed",
			answerMessageId: "answer",
		}),
		answerText: () => "回答",
		cancel: async () => null,
	} as unknown as ReturnType<typeof createDialogueService>;
	const larm = withLanguageControl({
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
		status: "ready" | "failed",
	) {
		const id = crypto.randomUUID();
		ids.push(id);
		await voice.accept(sessionId, 1, sequence, id, wav);
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
	const store = openStore(join(dir, "db.sqlite3"), [
		migration,
		sequenceMigration,
	]);
	let asr = 0;
	const larm = withLanguageControl({
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
					source: "laya",
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

test("a clause that keeps failing is skipped and the rest is still spoken", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-voice-skip-"));
	try {
		const store = openStore(join(dir, "db.sqlite3"), [
			migration,
			sequenceMigration,
		]);
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
			waitForTerminal: async () => ({
				status: "completed",
				answerMessageId: "answer",
			}),
			answerText: () => "最初です。壊れます。最後です。",
			cancel: async () => null,
		} as unknown as ReturnType<typeof createDialogueService>;
		const calls: string[] = [];
		const larm = withLanguageControl({
			status: () => ({ state: "ready", capabilities: ["llm", "asr", "tts"] }),
			connect: async () => {},
			answer: async () => "回答",
			transcribe: async () => "質問",
			speak: async (text) => {
				calls.push(text);
				if (text.includes("壊れ")) throw new Error("larm_inference_500");
				return wav;
			},
			close: async () => {},
		});
		const voice = createVoiceDialogue(store, dialogue, larm);
		const sessionId = crypto.randomUUID(),
			utteranceId = crypto.randomUUID();
		voice.start(sessionId, 1);
		await voice.accept(sessionId, 1, 1, utteranceId, wav);
		for (let i = 0; i < 100 && voice.get(utteranceId)?.status !== "ready"; i++)
			await pause(20);
		expect(voice.get(utteranceId)?.status).toBe("ready");
		expect(calls.filter((t) => t.includes("壊れ"))).toHaveLength(3);
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
});

test("clauses without any phoneme are never sent to TTS", () => {
	expect(new SpeechSentences().append("はい。…。！？ 次です。", true)).toEqual([
		"はい。",
		"次です。",
	]);
});

test("a failed turn stores only a machine-readable error code", async () => {
	for (const [thrown, expected] of [
		["connect ECONNREFUSED 192.168.0.2:9810", "voice_failed"],
		["asr_language_not_allowed", "asr_language_not_allowed"],
	] as const) {
		const dir = mkdtempSync(join(tmpdir(), "eumenes-voice-error-"));
		const store = openStore(join(dir, "db.sqlite3"), [
			migration,
			sequenceMigration,
		]);
		const larm = withLanguageControl({
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

async function raceFixture(
	prefix: string,
	executeControl?: InferencePort["executeControl"],
) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	const base = withLanguageControl({
		status: () => ({ state: "ready", capabilities: ["llm", "asr", "tts"] }),
		connect: async () => {},
		answer: async () => "回答",
		transcribe: async () => "質問",
		speak: async () => wav,
		close: async () => {},
	});
	const larm = executeControl ? { ...base, executeControl } : base;
	const store = openStore(join(dir, "db.sqlite3"), [
		conversationMigration,
		conversationAvatarMotionMigration,
		conversationAnswerDeliveryMigration,
		dialogueMigration,
		migration,
		queueMigration,
		queueLinkMigration,
		sequenceMigration,
	]);
	const conversation = createConversationService(store);
	const queue = createQueue(store);
	queue.start();
	const dialogue = createDialogueService({ store, conversation, larm, queue });
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

test("cancelling while the language check resolves leaves no running dialogue run", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	let inner: InferencePort["executeControl"];
	const f = await raceFixture("eumenes-voice-race-a-", async (...args) => {
		await gate;
		return inner!(...args);
	});
	inner = f.base.executeControl;
	const voice = createVoiceDialogue(f.store, f.dialogue, f.larm);
	try {
		const sessionId = crypto.randomUUID(),
			id = crypto.randomUUID();
		voice.start(sessionId, 1);
		await voice.accept(sessionId, 1, 1, id, wav);
		release();
		await voice.cancel(id);
		await voice.stop(sessionId, 1);
		await f.queue.close(100);
		expect(voice.get(id)?.status).toBe("cancelled");
		for (const run of f.dialogue.list("main"))
			expect(run.status).toBe("cancelled");
	} finally {
		await voice.close();
		rmSync(f.dir, { recursive: true, force: true });
		await f.store.close().catch(() => {});
	}
});

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

test("a failing cleanup write neither rejects unhandled nor breaks close", async () => {
	const f = await raceFixture("eumenes-voice-cleanup-", async () => {
		throw new Error("asr_language_not_allowed");
	});
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	const larm = {
		...f.larm,
		cancelRequestsInTransaction: () => {
			throw new Error("database_writer_queue_full");
		},
	};
	const voice = createVoiceDialogue(f.store, f.dialogue, larm);
	try {
		const sessionId = crypto.randomUUID(),
			id = crypto.randomUUID();
		voice.start(sessionId, 1);
		await voice.accept(sessionId, 1, 1, id, wav);
		for (let i = 0; i < 100 && voice.get(id)?.status !== "failed"; i++)
			await pause(10);
		await pause(50);
		expect(voice.get(id)?.status).toBe("failed");
		expect((await voice.accept(sessionId, 1, 1, id, wav)).utteranceId).toBe(id);
		expect(unhandled).toEqual([]);
		await voice.close().catch(() => {});
	} finally {
		process.off("unhandledRejection", onUnhandled);
		await f.close();
	}
});
