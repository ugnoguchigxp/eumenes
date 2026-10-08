import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createConversationService,
	migration as conversationMigration,
	avatarMotionMigration as conversationAvatarMotionMigration,
	answerDeliveryMigration as conversationAnswerDeliveryMigration,
} from "../../conversation";
import {
	createDialogueService,
	migration as dialogueMigration,
	queueLinkMigration,
} from "../../dialogue";
import { createQueue, migration as queueMigration } from "../../queue";
import { migration as schedulerMigration } from "../../scheduler";
import {
	createSettings,
	migration as settingsMigration,
	epochsMigration as settingsEpochsMigration,
} from "../../settings";
import {
	createInference,
	migration as inferenceMigration,
	parentsMigration as inferenceParentsMigration,
	diagnosticsMigration as inferenceDiagnosticsMigration,
} from "../../inference";
import { createVoiceDialogue, migration, sequenceMigration } from "..";
import type { LarmPort } from "../../larm";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});
function wav() {
	const b = new Uint8Array(48);
	b.set(new TextEncoder().encode("RIFF"));
	b.set(new TextEncoder().encode("WAVE"), 8);
	return b;
}
async function setup(
	fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
	local: Partial<LarmPort> = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-settings-voice-"));
	const dbPath = join(dir, "test.db");
	const store = openStore(dbPath, [
		conversationMigration,
		conversationAvatarMotionMigration,
		conversationAnswerDeliveryMigration,
		dialogueMigration,
		migration,
		queueMigration,
		schedulerMigration,
		queueLinkMigration,
		sequenceMigration,
		settingsMigration,
		inferenceMigration,
		settingsEpochsMigration,
		inferenceParentsMigration,
		inferenceDiagnosticsMigration,
	]);
	const settings = await createSettings(store, { dbPath, env: {} });
	const value = settings.get();
	const c = crypto.randomUUID();
	value.connections.push({
		id: c,
		name: "fixture",
		baseUrl: "http://127.0.0.1:18899/v1",
		epoch: 0,
		enabled: true,
		envRef: null,
	});
	for (const p of ["llm", "asr", "tts"] as const) {
		const id = crypto.randomUUID();
		value.resources.push({
			id,
			connectionId: c,
			purpose: p,
			model: `fixture-${p}`,
			contextWindow: p === "llm" ? 8192 : null,
			voice: p === "tts" ? "test" : null,
		});
		value.routes[p].fallbackId = id;
	}
	await settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: 0,
		settings: value,
		keys: [{ connectionId: c, value: "fixture-key" }],
	});
	const calls: string[] = [];
	const defaultFetch = async (url: unknown) => {
		calls.push(String(url));
		return String(url).endsWith("audio/transcriptions")
			? Response.json({ text: "fixture speech" })
			: String(url).endsWith("audio/speech")
				? new Response(wav())
				: Response.json({
						choices: [{ message: { content: "fixture answer" } }],
					});
	};
	const inference = createInference(store, settings, {
		fetch: fetcher ?? defaultFetch,
		larmFactory: () => ({
			status: () => ({ state: "unconfigured", capabilities: [] }),
			connect: async () => {},
			answer: async () => {
				throw new Error("larm_unconfigured");
			},
			transcribe: async () => {
				throw new Error("larm_unconfigured");
			},
			speak: async () => {
				throw new Error("larm_unconfigured");
			},
			close: async () => {},
			...local,
		}),
	});
	const conversation = createConversationService(store);
	const queue = createQueue(store, { pollMs: 5 });
	const dialogue = createDialogueService(store, conversation, inference, queue);
	const voice = createVoiceDialogue(store, dialogue, inference);
	queue.start();
	cleanup.push(async () => {
		await voice.close();
		await queue.close();
		await inference.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return {
		store,
		settings,
		inference,
		conversation,
		dialogue,
		voice,
		queue,
		calls,
	};
}
async function until(condition: () => boolean) {
	for (let i = 0; i < 300; i++) {
		if (condition()) return;
		await Bun.sleep(5);
	}
	throw new Error("condition_not_reached");
}
test("one voice turn uses fallback in all three stages, adopts one answer, and does not repeat duplicate upload", async () => {
	const h = await setup();
	const session = crypto.randomUUID(),
		id = crypto.randomUUID();
	h.voice.start(session, 1);
	await h.voice.accept(session, 1, 1, id, wav());
	await h.voice.accept(session, 1, 1, id, wav());
	await until(() => h.voice.get(id)?.status === "ready");
	expect(h.calls).toHaveLength(3);
	expect(h.dialogue.list("main")).toHaveLength(1);
	expect(h.conversation.get("main").messages.map((m) => m.text)).toEqual([
		"fixture speech",
		"fixture answer",
	]);
	expect(h.voice.takeAudio(id)).toEqual(wav());
	const revoked = h.settings.get();
	revoked.routes.tts.cloudAllowed = false;
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: revoked.revision,
		settings: revoked,
		keys: [],
	});
	expect(h.voice.takeAudio(id)).toBeNull();
});
test("autoSpeak false is captured at voice acceptance and ends successfully without TTS", async () => {
	const h = await setup();
	const value = h.settings.get();
	value.voice.autoSpeak = false;
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: value.revision,
		settings: value,
		keys: [],
	});
	const session = crypto.randomUUID(),
		id = crypto.randomUUID();
	h.voice.start(session, 1);
	await h.voice.accept(session, 1, 1, id, wav());
	const changed = h.settings.get();
	changed.voice.autoSpeak = true;
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: changed.revision,
		settings: changed,
		keys: [],
	});
	await until(() => h.voice.get(id)?.status === "completed");
	expect(h.calls).toHaveLength(2);
	expect(h.voice.takeAudio(id)).toBeNull();
	expect(h.dialogue.list("main")[0]?.status).toBe("completed");
	expect(
		h.store.read((db) =>
			db
				.query(
					"SELECT status FROM inference_requests WHERE subject=? AND purpose='tts'",
				)
				.get(id),
		),
	).toEqual({ status: "skipped" });
});
test("cancellation during cloud ASR cannot create a dialogue run even with late HTTP completion", async () => {
	let finish!: (r: Response) => void;
	let called = false;
	const h = await setup(async () => {
		called = true;
		return new Promise((r) => {
			finish = r;
		});
	});
	const session = crypto.randomUUID(),
		id = crypto.randomUUID();
	h.voice.start(session, 1);
	await h.voice.accept(session, 1, 1, id, wav());
	await until(() => called);
	await h.voice.cancel(id);
	finish(Response.json({ text: "late speech" }));
	await Bun.sleep(30);
	expect(h.voice.get(id)?.status).toBe("cancelled");
	expect(h.dialogue.list("main")).toHaveLength(0);
	expect(h.conversation.get("main").messages).toHaveLength(0);
});
test("queued snapshots survive recovery without re-running an attempted provider", async () => {
	const h = await setup();
	const id = await h.store.write((db) =>
		h.inference.captureInTransaction(db, "queued", "llm", Date.now() + 10000),
	);
	await h.inference.recover();
	const receipt = await h.inference.executeRequest(
		id,
		[{ role: "user", content: "hello" }],
		new AbortController().signal,
	);
	await h.inference.recover();
	await expect(
		h.inference.executeRequest(
			id,
			[{ role: "user", content: "hello" }],
			new AbortController().signal,
		),
	).rejects.toThrow("permission_revoked");
	expect(
		await h.store.write((db) => h.inference.acceptInTransaction(db, receipt)),
	).toBe(false);
});

test("revoking a cloud answer aborts downstream TTS and never publishes late audio", async () => {
	let finish!: (r: Response) => void;
	let synthesizing = false;
	const h = await setup(async (input) => {
		const url = String(input);
		if (url.endsWith("audio/transcriptions"))
			return Response.json({ text: "speech" });
		if (url.endsWith("chat/completions"))
			return Response.json({ choices: [{ message: { content: "answer" } }] });
		synthesizing = true;
		return new Promise<Response>((r) => {
			finish = r;
		});
	});
	const session = crypto.randomUUID(),
		id = crypto.randomUUID();
	h.voice.start(session, 1);
	await h.voice.accept(session, 1, 1, id, wav());
	await until(() => synthesizing);
	const next = h.settings.get();
	next.routes.llm.cloudAllowed = false;
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: next.revision,
		settings: next,
		keys: [],
	});
	await until(() => h.voice.get(id)?.status === "failed");
	finish(new Response(wav()));
	await Bun.sleep(15);
	expect(h.voice.takeAudio(id)).toBeNull();
	expect(h.dialogue.list("main")[0]?.status).toBe("completed");
	expect(
		(h.inference.usage() as { purpose: string; accepted: number }[]).filter(
			(a) => a.purpose === "tts" && a.accepted,
		),
	).toHaveLength(0);
});

test("a provisional sentence is playable while LLM is running and cancellation clears both streams", async () => {
	let sink!: ReadableStreamDefaultController<Uint8Array>;
	const spoken: string[] = [];
	const h = await setup(async (url, init) => {
		if (String(url).endsWith("audio/transcriptions"))
			return Response.json({ text: "質問" });
		if (String(url).endsWith("audio/speech")) {
			spoken.push(
				(JSON.parse(init?.body as string) as { input: string }).input,
			);
			return new Response(wav());
		}
		expect(
			(JSON.parse(init?.body as string) as { stream: boolean }).stream,
		).toBe(true);
		return new Response(
			new ReadableStream<Uint8Array>({
				start(c) {
					sink = c;
					c.enqueue(
						new TextEncoder().encode(
							'data: {"choices":[{"index":0,"delta":{"content":"先にお届けします。"}}]}\n\n',
						),
					);
				},
			}),
			{ headers: { "Content-Type": "text/event-stream" } },
		);
	});
	const session = crypto.randomUUID(),
		id = crypto.randomUUID();
	h.voice.start(session, 1);
	await h.voice.accept(session, 1, 1, id, wav());
	await until(() => !!h.voice.get(id)?.audioChunks?.length);
	const runId = h.voice.get(id)!.runId!;
	expect(h.dialogue.get(runId)?.status).toBe("running");
	expect(h.dialogue.progress(runId)?.text).toBe("先にお届けします。");
	expect(h.conversation.get("main").messages.map((m) => m.text)).toEqual([
		"質問",
	]);
	expect(h.voice.takeAudio(id, 0)).toEqual(wav());
	expect(spoken).toEqual(["先にお届けします。"]);
	await h.voice.cancel(id);
	expect(h.voice.takeAudio(id, 0)).toBeNull();
	expect(h.dialogue.progress(runId)?.text).toBe("");
	try {
		sink.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
		sink.close();
	} catch {
		/* canceled reader */
	}
	await Bun.sleep(10);
	expect(h.conversation.get("main").messages.map((m) => m.text)).toEqual([
		"質問",
	]);
});

test("render ahead is bounded at three clauses and playback releases the next clause", async () => {
	const spoken: string[] = [];
	const source = "一。二。三。四。五。六。";
	const h = await setup(async (url, init) => {
		if (String(url).endsWith("audio/transcriptions"))
			return Response.json({ text: "質問" });
		if (String(url).endsWith("audio/speech")) {
			spoken.push(JSON.parse(init?.body as string).input);
			return new Response(wav());
		}
		const text = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: source } }] })}\n\ndata: [DONE]\n\n`;
		return new Response(text, {
			headers: { "Content-Type": "text/event-stream" },
		});
	});
	const session = crypto.randomUUID(),
		id = crypto.randomUUID();
	h.voice.start(session, 1);
	await h.voice.accept(session, 1, 1, id, wav());
	await until(() => h.voice.get(id)?.audioChunks?.length === 3);
	await Bun.sleep(15);
	expect(spoken).toEqual(["一。", "二。", "三。"]);
	await h.voice.played(id, 0);
	await until(() => spoken.length === 4);
	expect(h.voice.get(id)?.audioChunks?.length).toBeLessThanOrEqual(3);
	for (let index = 1; index < 6; index++) {
		await until(() => !!h.voice.takeAudio(id, index));
		await h.voice.played(id, index);
	}
	await until(() => h.voice.get(id)?.status === "played");
	expect(spoken).toEqual(["一。", "二。", "三。", "四。", "五。", "六。"]);
});
test("final recognition preempts a slow prefix and never submits a late hypothesis", async () => {
	let first = true,
		started = false,
		release: () => void = () => {};
	const h = await setup(async (url) => {
		if (String(url).endsWith("audio/transcriptions")) {
			if (first) {
				first = false;
				started = true;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return Response.json({ text: "古い仮説" });
			}
			return Response.json({ text: "確定" });
		}
		if (String(url).endsWith("audio/speech")) return new Response(wav());
		return Response.json({ choices: [{ message: { content: "回答" } }] });
	});
	const session = crypto.randomUUID(),
		id = crypto.randomUUID();
	h.voice.start(session, 1);
	const prefix = h.voice.preview(session, 1, id, wav());
	await until(() => started);
	await h.voice.accept(session, 1, 1, id, wav());
	expect((await prefix).text).toBe("");
	release();
	await until(() => h.voice.get(id)?.status === "ready");
	expect(h.conversation.get("main").messages.map((m) => m.text)).toEqual([
		"確定",
		"回答",
	]);
});

test("accepted audio chunks publish Laya delivery and cancellation removes the plan with the audio", async () => {
	const h = await setup(undefined, {
		answer: async () => "こんにちは。",
		transcribe: async () => "挨拶してください",
		speak: async () => wav(),
		judge: async () => ({
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
		}),
	});
	const session = crypto.randomUUID(),
		id = crypto.randomUUID();
	h.voice.start(session, 1);
	await h.voice.accept(session, 1, 1, id, wav());
	await until(() => h.voice.get(id)?.status === "ready");
	expect(h.voice.get(id)?.audioChunks).toEqual([
		expect.objectContaining({
			index: 0,
			text: "こんにちは。",
			delivery: expect.objectContaining({
				source: "laya",
				motion: "greeting",
				tone: "bright",
			}),
		}),
	]);
	expect(
		h.conversation
			.get("main")
			.messages.find((message) => message.role === "assistant")?.avatarMotion,
	).toBe("greeting");
	expect(h.voice.takeAudio(id, 0)).toEqual(wav());
	await h.voice.cancel(id);
	expect(h.voice.get(id)?.audioChunks).toEqual([]);
	expect(h.voice.takeAudio(id, 0)).toBeNull();
});

test("replaying an answer persists its native motion, rejects unrelated text and ignores cancelled synthesis", async () => {
	const h = await setup(undefined, {
		answer: async () => "よかったですね。",
		speak: async () => wav(),
		judge: async () => ({
			answers: {
				motion: {
					type: "choice",
					choice: "joyful",
					confidence: 0.95,
					answer_confidence: 0.95,
				},
				voice: {
					type: "choice",
					choice: "bright",
					confidence: 0.9,
					answer_confidence: 0.9,
				},
			},
		}),
	});
	const run = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "良い知らせ",
	});
	await until(() => h.dialogue.get(run.id)?.status === "completed");
	const answer = () =>
		h.conversation
			.get("main")
			.messages.find((message) => message.role === "assistant");
	expect(answer()?.avatarMotion).toBeUndefined();
	await expect(
		h.voice.replaySpeech(
			"関係のない回答。",
			new AbortController().signal,
			run.id,
		),
	).rejects.toThrow("replay_text_invalid");
	const aborted = new AbortController();
	aborted.abort();
	await expect(
		h.voice.replaySpeech("よかったですね。", aborted.signal, run.id),
	).rejects.toThrow();
	expect(answer()?.avatarMotion).toBeUndefined();
	const response = await h.voice.replaySpeech(
		"よかったですね。",
		new AbortController().signal,
		run.id,
	);
	expect(response.wav).toEqual(wav());
	expect(answer()).toMatchObject({
		text: "よかったですね。",
		avatarMotion: "joyful",
	});
});
