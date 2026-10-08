import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import {
	migration as conversationMigration,
	createConversationService,
} from "../../conversation";
import {
	createDialogueService,
	migration as dialogueMigration,
	queueLinkMigration,
} from "../../dialogue";
import type { LarmPort } from "../../larm";
import { createQueue, migration as queueMigration } from "../../queue";
import { createVoiceDialogue, migration, sequenceMigration } from "..";

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
	const larm: LarmPort = {
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
	};
	try {
		const store = openStore(join(dir, "db.sqlite3"), [
			conversationMigration,
			dialogueMigration,
			migration,
			queueMigration,
			queueLinkMigration,
			sequenceMigration,
		]);
		const conversation = createConversationService(store);
		const queue = createQueue(store);
		queue.start();
		const dialogue = createDialogueService(store, conversation, larm, queue);
		let failNextWrite = false;
		const voiceStore: SqliteStore = {
			onCommit: (listener) => store.onCommit(listener),
			read: (operation) => store.read(operation),
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
	const larm: LarmPort = {
		status: () => ({ state: "ready", capabilities: ["llm", "asr", "tts"] }),
		connect: async () => {},
		answer: () => new Promise(() => {}),
		transcribe: async () => "質問",
		speak: async () => wav,
		close: async () => {},
	};
	try {
		const store = openStore(join(dir, "db.sqlite3"), [
			conversationMigration,
			dialogueMigration,
			migration,
			queueMigration,
			queueLinkMigration,
			sequenceMigration,
		]);
		const conversation = createConversationService(store);
		const queue = createQueue(store);
		const dialogue = createDialogueService(store, conversation, larm, queue);
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
		const dialogue2 = createDialogueService(store, conversation, larm, queue2);
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

test("evicting cached audio also clears the ready state", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-voice-evict-"));
	try {
		const store = openStore(join(dir, "db.sqlite3"), [
			migration,
			sequenceMigration,
		]);
		const dialogue = {
			submit: async () => ({ id: crypto.randomUUID(), deadlineAt: null }),
			get: () => ({ status: "completed" }),
			subscribeProgress: () => () => {},
			waitForTerminal: async () => ({
				status: "completed",
				answerMessageId: "answer",
			}),
			answerText: () => "回答",
			cancel: async () => null,
		} as unknown as ReturnType<typeof createDialogueService>;
		const larm: LarmPort = {
			status: () => ({ state: "ready", capabilities: ["llm", "asr", "tts"] }),
			connect: async () => {},
			answer: async () => "回答",
			transcribe: async () => "質問",
			speak: async () => wav,
			close: async () => {},
		};
		const voice = createVoiceDialogue(store, dialogue, larm);
		const sessionId = crypto.randomUUID();
		voice.start(sessionId, 1);
		const ids = Array.from({ length: 9 }, () => crypto.randomUUID());
		for (const [index, utteranceId] of ids.entries())
			await voice.accept(sessionId, 1, index + 1, utteranceId, wav);
		for (
			let i = 0;
			i < 100 &&
			(voice.get(ids[0] as string)?.status !== "failed" ||
				voice.get(ids[8] as string)?.status !== "ready");
			i++
		)
			await pause(10);
		expect(voice.get(ids[0] as string)?.status).toBe("failed");
		expect(voice.get(ids[0] as string)?.error).toBe("audio_evicted");
		expect(voice.takeAudio(ids[0] as string)).toBeNull();
		expect(voice.get(ids[8] as string)?.status).toBe("ready");
		await voice.close();
		await store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
