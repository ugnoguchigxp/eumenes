import { createApp } from "../../../application/app";
import { registerVoiceDialogue } from "..";
import {
	inputMigration,
	inputSimplificationMigration,
	inputTextDedupMigration,
} from "../repository/input";
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
	migrations as inferenceMigrations,
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
		inputMigration,
		inputSimplificationMigration,
		inputTextDedupMigration,
		settingsMigration,
		inferenceMigration,
		settingsEpochsMigration,
		inferenceParentsMigration,
		inferenceDiagnosticsMigration,
		...inferenceMigrations.slice(3).map((m) => m.sql),
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
			transcribe: async () => {
				throw new Error("larm_unconfigured");
			},
			speak: async () => {
				throw new Error("larm_unconfigured");
			},
			close: async () => {},
			...local,
			answer: async (messages, signal, options) =>
				local.answer
					? local.answer(messages, signal, options)
					: Promise.reject(new Error("larm_unconfigured")),
		}),
	});
	const conversation = createConversationService(store);
	const queue = createQueue(store, { pollMs: 5 });
	const dialogue = createDialogueService({
		store,
		conversation,
		larm: inference,
		queue,
	});
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
/** Uploads one segment and sends it once transcribed, as the Web does when the speaker is idle. */
async function say(
	h: Awaited<ReturnType<typeof setup>>,
	session: string,
	id: string,
) {
	await h.voice.accept(session, 1, 1, id, wav());
	await until(() => h.voice.get(id)?.status !== "recognizing");
	const turn = h.voice.get(id)!;
	if (turn.status === "input_ready") await h.voice.commit(id, turn.revision);
}
test("one voice turn uses fallback in all three stages, adopts one answer, and does not repeat duplicate upload", async () => {
	const h = await setup();
	const session = crypto.randomUUID(),
		id = crypto.randomUUID();
	h.voice.start(session, 1);
	await say(h, session, id);
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
	await say(h, session, id);
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
	await say(h, session, id);
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

test("streaming text is visible but speech waits for completion; cancellation prevents partial-answer emotion", async () => {
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
	await say(h, session, id);
	await until(
		() =>
			!!h.voice.get(id)?.runId &&
			h.dialogue.progress(h.voice.get(id)!.runId!)?.text ===
				"先にお届けします。",
	);
	const runId = h.voice.get(id)!.runId!;
	expect(h.dialogue.get(runId)?.status).toBe("running");
	expect(h.dialogue.progress(runId)?.text).toBe("先にお届けします。");
	expect(h.conversation.get("main").messages.map((m) => m.text)).toEqual([
		"質問",
	]);
	expect(h.voice.takeAudio(id, 0)).toBeNull();
	expect(spoken).toEqual([]);
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
	await say(h, session, id);
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
	await say(h, session, id);
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
				emotion: {
					type: "choice",
					choice: "warmth",
					confidence: 0.9,
					answer_confidence: 0.9,
				},
			},
		}),
	});
	const session = crypto.randomUUID(),
		id = crypto.randomUUID();
	h.voice.start(session, 1);
	await say(h, session, id);
	await until(() => h.voice.get(id)?.status === "ready");
	expect(h.voice.get(id)?.audioChunks).toEqual([
		expect.objectContaining({
			index: 0,
			text: "こんにちは。",
			delivery: expect.objectContaining({
				source: "laya",
				motion: "agreeing",
				tone: "bright",
			}),
		}),
	]);
	expect(
		h.conversation
			.get("main")
			.messages.find((message) => message.role === "assistant")?.delivery
			?.emotion,
	).toBe("warmth");
	expect(h.voice.takeAudio(id, 0)).toEqual(wav());
	await h.voice.cancel(id);
	expect(h.voice.get(id)?.audioChunks).toEqual([]);
	expect(h.voice.takeAudio(id, 0)).toBeNull();
});

test("replaying an answer persists its native motion, rejects unrelated text and ignores cancelled synthesis", async () => {
	const h = await setup(undefined, {
		answer: async () => "合格おめでとうございます。",
		speak: async () => wav(),
		judge: async () => ({
			answers: {
				emotion: {
					type: "choice",
					choice: "joy",
					confidence: 0.95,
					answer_confidence: 0.95,
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
		h.voice.replaySpeech("合格おめでとうございます。", aborted.signal, run.id),
	).rejects.toThrow();
	expect(answer()?.avatarMotion).toBeUndefined();
	const response = await h.voice.replaySpeech(
		"合格おめでとうございます。",
		new AbortController().signal,
		run.id,
	);
	expect(response.wav).toEqual(wav());
	expect(answer()).toMatchObject({
		text: "合格おめでとうございます。",
		delivery: expect.objectContaining({ emotion: "joy", source: "laya" }),
	});
});

test("one adopted full-answer emotion works with audio off and is reused for all clauses and replay", async () => {
	let judgments = 0;
	const observed: Array<Record<string, string>> = [];
	const h = await setup(undefined, {
		answer: async () => "なるほど。素敵な名前ですね。ありがとうございます。",
		speak: async () => wav(),
		judge: async (state) => {
			judgments++;
			observed.push(state);
			return {
				answers: {
					emotion: {
						type: "choice",
						choice: "warmth",
						confidence: 0.9,
						answer_confidence: 0.9,
					},
				},
			};
		},
	});
	const off = h.settings.get();
	off.voice.autoSpeak = false;
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: off.revision,
		settings: off,
		keys: [],
	});
	const run = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "大切な猫の名前です。",
	});
	await until(() => h.dialogue.get(run.id)?.status === "completed");
	const saved = h.dialogue.answerDelivery(run.id);
	expect(saved).toMatchObject({
		version: 2,
		emotion: "warmth",
		source: "laya",
	});
	expect(judgments).toBe(1);
	expect(observed[0]?.response).toBe(
		"なるほど。素敵な名前ですね。ありがとうございます。",
	);
	expect(observed[0]?.conversation).toContain("大切な猫の名前です。");
	for (const text of h.voice.replaySentences(h.dialogue.answerText(run.id)!)) {
		const speech = await h.voice.replaySpeech(
			text,
			new AbortController().signal,
			run.id,
		);
		expect(speech.delivery?.id).toBe(saved?.id);
	}
	expect(judgments).toBe(1);
});

test("automatic three-clause speech shares the adopted full-answer decision", async () => {
	let judgments = 0;
	const h = await setup(undefined, {
		transcribe: async () => "大切な猫の名前です。",
		answer: async () => "なるほど。素敵な名前ですね。ありがとうございます。",
		speak: async () => wav(),
		judge: async () => {
			judgments++;
			return {
				answers: {
					emotion: {
						type: "choice",
						choice: "warmth",
						confidence: 0.9,
						answer_confidence: 0.9,
					},
				},
			};
		},
	});
	const id = crypto.randomUUID();
	h.voice.start("shared-emotion", 1);
	await say(h, "shared-emotion", id);
	await until(() => h.voice.get(id)?.status === "ready");
	const turn = h.voice.get(id)!;
	const saved = h.dialogue.answerDelivery(turn.runId!);
	expect(turn.audioChunks).toHaveLength(3);
	for (const chunk of turn.audioChunks)
		expect(chunk.delivery?.id).toBe(saved?.id);
	expect(saved?.emotion).toBe("warmth");
	expect(judgments).toBe(1);
});

test("cancelling during final Laya classification rejects late emotion and assistant text", async () => {
	let entered = false;
	let finish!: (value: unknown) => void;
	const pending = new Promise<unknown>((resolve) => {
		finish = resolve;
	});
	const h = await setup(undefined, {
		answer: async () => "素敵な名前ですね。",
		judge: async () => {
			entered = true;
			return pending;
		},
	});
	const run = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "猫の名前です。",
	});
	await until(() => entered);
	await h.dialogue.cancel(run.id);
	finish({
		answers: {
			emotion: {
				type: "choice",
				choice: "warmth",
				confidence: 0.99,
				answer_confidence: 0.99,
			},
		},
	});
	await Bun.sleep(20);
	expect(h.dialogue.get(run.id)?.status).toBe("cancelled");
	expect(h.dialogue.answerDelivery(run.id)).toBeUndefined();
	expect(
		h.conversation.get("main").messages.map((message) => message.role),
	).toEqual(["user"]);
});

const ready = (): ReturnType<LarmPort["status"]> => ({
	state: "ready",
	capabilities: ["llm", "asr", "tts"],
});
const controlRequests = (h: Awaited<ReturnType<typeof setup>>) =>
	h.store.read((db) =>
		db
			.query(
				"SELECT COUNT(*) AS n FROM inference_requests WHERE mode='control'",
			)
			.get(),
	);

test("cancelling during ASR rejects the late transcript before dialogue or speech", async () => {
	let finish!: (value: string) => void;
	const h = await setup(undefined, {
		status: ready,
		transcribe: () =>
			new Promise<string>((resolve) => {
				finish = resolve;
			}),
	});
	const session = crypto.randomUUID(),
		id = crypto.randomUUID();
	h.voice.start(session, 1);
	await h.voice.accept(session, 1, 1, id, wav());
	await until(() => !!finish);
	await h.voice.cancel(id);
	finish("遅れて届いた文字起こし");
	await Bun.sleep(30);
	expect(h.voice.get(id)?.status).toBe("cancelled");
	expect(h.voice.get(id)?.text).toBeNull();
	expect(h.dialogue.list("main")).toHaveLength(0);
	expect(h.voice.takeAudio(id)).toBeNull();
});

test("a transcript is ready as heard, with no language or endpoint control", async () => {
	const h = await setup(undefined, {
		status: ready,
		transcribe: async () => "Hello, 今日の予定は？",
	});
	const session = crypto.randomUUID(),
		id = crypto.randomUUID();
	h.voice.start(session, 1);
	await h.voice.accept(session, 1, 1, id, wav());
	await until(() => h.voice.get(id)?.status === "input_ready");
	expect(h.voice.get(id)?.text).toBe("Hello, 今日の予定は？");
	expect(controlRequests(h)).toEqual({ n: 0 });
});

test("empty final ASR creates no dialogue", async () => {
	const h = await setup(undefined, {
		status: ready,
		transcribe: async () => "",
	});
	const session = crypto.randomUUID(),
		id = crypto.randomUUID();
	h.voice.start(session, 1);
	await h.voice.accept(session, 1, 1, id, wav());
	await until(() =>
		["completed", "failed"].includes(h.voice.get(id)?.status ?? ""),
	);
	expect(h.voice.get(id)?.status, JSON.stringify(h.voice.get(id))).toBe(
		"completed",
	);
	expect(h.dialogue.list("main")).toHaveLength(0);
});

test("ASR permission revocation after staging rejects commit", async () => {
	const h = await setup();
	const session = crypto.randomUUID(),
		id = crypto.randomUUID();
	h.voice.start(session, 1);
	await h.voice.accept(session, 1, 1, id, wav());
	await until(() => h.voice.get(id)!.status === "input_ready");
	const value = h.settings.get();
	value.routes.asr.cloudAllowed = false;
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: value.revision,
		settings: value,
		keys: [],
	});
	await expect(h.voice.commit(id, h.voice.get(id)!.revision)).rejects.toThrow(
		"permission_revoked",
	);
	expect(h.dialogue.list("main")).toHaveLength(0);
});

test("an answered input forms a boundary: the next segment starts a new input", async () => {
	let count = 0;
	const h = await setup(undefined, {
		status: ready,
		transcribe: async () => ["人口を教えて", "ありがとう"][count++]!,
		answer: async () => "人口の回答",
		speak: async () => wav(),
	});
	const session = crypto.randomUUID(),
		ids = [crypto.randomUUID(), crypto.randomUUID()];
	h.voice.start(session, 1);
	await h.voice.accept(session, 1, 1, ids[0]!, wav());
	await until(() => h.voice.get(ids[0]!)!.status === "input_ready");
	await h.voice.commit(ids[0]!, h.voice.get(ids[0]!)!.revision);
	await until(() => h.voice.get(ids[0]!)!.status === "ready");
	await h.voice.accept(session, 1, 2, ids[1]!, wav());
	await until(() => h.voice.get(ids[1]!)!.status === "input_ready");
	expect(h.voice.get(ids[1]!)!.text).toBe("ありがとう");
});

test("segments sent before commit merge into one input and create one answer", async () => {
	const fragments = [
		"じゃあ今日は。",
		"イラン側の。",
		"最新のニュースを教えてください。",
	];
	let recognized = 0,
		answers = 0;
	const h = await setup(undefined, {
		status: ready,
		transcribe: async () => fragments[recognized++]!,
		answer: async () => {
			answers++;
			return "まとめた依頼への回答です。";
		},
		speak: async () => wav(),
	});
	const session = crypto.randomUUID(),
		ids = fragments.map(() => crypto.randomUUID());
	h.voice.start(session, 1);
	for (let i = 0; i < ids.length; i++) {
		await h.voice.accept(session, 1, i + 1, ids[i]!, wav());
		await until(() => h.voice.get(ids[i]!)!.status === "input_ready");
		expect(h.dialogue.list("main")).toHaveLength(0);
	}
	const final = h.voice.get(ids[2]!)!;
	expect(final.text).toBe(fragments.join("\n"));
	expect(h.voice.get(ids[0]!)!.status).toBe("merged");
	expect(h.voice.get(ids[1]!)!.status).toBe("merged");
	await h.voice.commit(ids[2]!, final.revision);
	await h.voice.commit(ids[2]!, final.revision);
	await until(() => h.voice.get(ids[2]!)!.status === "ready");
	expect(answers).toBe(1);
	expect(controlRequests(h)).toEqual({ n: 0 });
	expect(h.dialogue.list("main")).toHaveLength(1);
	expect(h.conversation.get("main").messages.map((m) => m.text)).toEqual([
		fragments.join("\n"),
		"まとめた依頼への回答です。",
	]);
});

test("an empty segment after a pause carries the pending input forward", async () => {
	let count = 0;
	const h = await setup(undefined, {
		status: ready,
		transcribe: async () => ["天気を教えて", ""][count++]!,
		answer: async () => "天気の回答",
		speak: async () => wav(),
	});
	const session = crypto.randomUUID(),
		first = crypto.randomUUID(),
		second = crypto.randomUUID();
	h.voice.start(session, 1);
	await h.voice.accept(session, 1, 1, first, wav());
	await until(() => h.voice.get(first)!.status === "input_ready");
	await h.voice.accept(session, 1, 2, second, wav());
	await until(() => h.voice.get(second)!.status === "input_ready");
	expect(h.voice.get(first)!.status).toBe("merged");
	expect(h.voice.get(second)!.text).toBe("天気を教えて");
	await h.voice.commit(second, h.voice.get(second)!.revision);
	await until(() => h.voice.get(second)!.status === "ready");
	expect(h.conversation.get("main").messages[0]!.text).toBe("天気を教えて");
});

test("a failed segment after a pause fails alone and never answers the pending input", async () => {
	let count = 0;
	const h = await setup(undefined, {
		status: ready,
		transcribe: async () => {
			if (count++ === 0) return "天気を教えて";
			throw new Error("larm_timeout");
		},
	});
	const session = crypto.randomUUID(),
		first = crypto.randomUUID(),
		second = crypto.randomUUID();
	h.voice.start(session, 1);
	await h.voice.accept(session, 1, 1, first, wav());
	await until(() => h.voice.get(first)!.status === "input_ready");
	await h.voice.accept(session, 1, 2, second, wav());
	await until(() => h.voice.get(second)!.status === "failed");
	expect(h.voice.get(first)!.status).toBe("input_ready");
	expect(h.dialogue.list("main")).toHaveLength(0);
});

test("a later accepted fragment blocks an older ready input, including while its ASR is delayed", async () => {
	let release!: () => void,
		count = 0;
	const h = await setup(undefined, {
		status: ready,
		transcribe: async () =>
			++count === 1
				? "天気を教えて"
				: (await new Promise<void>((r) => {
						release = r;
					}),
					"明日の分も"),
		answer: async () => "天気の回答",
		speak: async () => wav(),
	});
	const session = crypto.randomUUID(),
		first = crypto.randomUUID(),
		second = crypto.randomUUID();
	h.voice.start(session, 1);
	await h.voice.accept(session, 1, 1, first, wav());
	await until(() => h.voice.get(first)!.status === "input_ready");
	const revision = h.voice.get(first)!.revision;
	await h.voice.accept(session, 1, 2, second, wav());
	await until(() => !!release);
	await expect(h.voice.commit(first, revision)).rejects.toThrow(
		"voice_input_stale",
	);
	expect(h.dialogue.list("main")).toHaveLength(0);
	release();
	await until(() => h.voice.get(second)!.status === "input_ready");
	expect(h.voice.get(second)!.text).toBe("天気を教えて\n明日の分も");
});

test("a cancelled input is not merged into the next segment", async () => {
	let release!: () => void,
		count = 0;
	const h = await setup(undefined, {
		status: ready,
		transcribe: async () =>
			++count === 1
				? "ニュースの"
				: (await new Promise<void>((r) => {
						release = r;
					}),
					"続きです"),
	});
	const session = crypto.randomUUID(),
		first = crypto.randomUUID(),
		second = crypto.randomUUID();
	h.voice.start(session, 1);
	await h.voice.accept(session, 1, 1, first, wav());
	await until(() => h.voice.get(first)!.status === "input_ready");
	await h.voice.accept(session, 1, 2, second, wav());
	await until(() => !!release);
	await h.voice.cancel(first);
	release();
	await until(() => h.voice.get(second)!.status === "input_ready");
	expect(h.voice.get(first)!.status).toBe("cancelled");
	expect(h.voice.get(second)!.text).toBe("続きです");
	expect(h.dialogue.list("main")).toHaveLength(0);
});

test("an adopted mixed answer is routed per language part and synthesis stays bounded until playback acknowledgements", async () => {
	const source =
		"最初です。Open the door. 次です。Close the door. 最後です。Thank you.";
	const spoken: Array<[string, string | undefined]> = [];
	const h = await setup(undefined, {
		status: () => ({ state: "ready", capabilities: ["llm", "asr", "tts"] }),
		transcribe: async () => "質問",
		answer: async () => source,
		speak: async (text, _signal, options) => {
			spoken.push([text, options?.speechLanguage]);
			return wav();
		},
	});
	const value = h.settings.get();
	value.larm.englishSpeechEnabled = true;
	for (const p of ["llm", "asr", "tts"] as const)
		value.routes[p].mode = "larm-only";
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: value.revision,
		settings: value,
		keys: [],
	});
	const session = crypto.randomUUID(),
		id = crypto.randomUUID();
	h.voice.start(session, 1);
	await say(h, session, id);
	await until(() => h.voice.get(id)?.audioChunks.length === 3);
	expect(spoken).toEqual([
		["最初です。", "ja"],
		["Open the door.", "en"],
		["次です。", "ja"],
	]);
	for (let index = 0; index < 6; index++) {
		await until(() => !!h.voice.takeAudio(id, index));
		await h.voice.played(id, index);
	}
	await until(() => h.voice.get(id)?.status === "played");
	expect(spoken.slice(3)).toEqual([
		["Close the door.", "en"],
		["最後です。", "ja"],
		["Thank you.", "en"],
	]);
	const run = h.dialogue.list("main")[0]!;
	await h.voice.replaySpeech(
		"Open the door.",
		new AbortController().signal,
		run.id,
	);
	expect(spoken.at(-1)).toEqual(["Open the door.", "en"]);
});

test("without an English voice every clause is still spoken by the Japanese voice", async () => {
	const source = "First. Second. Third.";
	const spoken: Array<[string, string | undefined]> = [];
	const h = await setup(undefined, {
		status: () => ({ state: "ready", capabilities: ["llm", "asr", "tts"] }),
		transcribe: async () => "質問",
		answer: async () => source,
		speak: async (text, _signal, options) => {
			if (options?.speechLanguage === "en")
				throw new Error("speech_tts_target_unavailable");
			spoken.push([text, options?.speechLanguage]);
			return wav();
		},
	});
	const value = h.settings.get();
	value.larm.englishSpeechEnabled = true;
	for (const p of ["llm", "asr", "tts"] as const)
		value.routes[p].mode = "larm-only";
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: value.revision,
		settings: value,
		keys: [],
	});
	const session = crypto.randomUUID(),
		id = crypto.randomUUID();
	h.voice.start(session, 1);
	await say(h, session, id);
	await until(() => h.voice.get(id)?.audioChunks.length === 3);
	expect(spoken).toEqual([
		["First.", "ja"],
		["Second.", "ja"],
		["Third.", "ja"],
	]);
	expect(h.voice.get(id)?.status).not.toBe("failed");
	expect(h.conversation.get("main").messages.at(-1)?.text).toBe(source);
});

test("sample HTTP route executes inference with English speech routing and draft voice without persisting it", async () => {
	const h = await setup(undefined, {
		speak: async () => wav(),
	});
	const settings = h.settings.get();
	settings.larm.englishSpeechEnabled = true;
	settings.routes.tts.mode = "larm-only";
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: settings.revision,
		settings,
		keys: [],
	});
	const before = h.settings.get();
	const token = "sample-http-fixture-token-32-bytes";
	const app = createApp({
		token,
		origin: "http://127.0.0.1:5173",
		modules: [{ mount: (app) => registerVoiceDialogue(app, h.voice) }],
	});
	const response = await app.request("/api/voice/sample", {
		method: "POST",
		headers: {
			Authorization: "Bearer " + token,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			voice: "unsaved-voice",
			speed: 1.1,
			style: "draft-style",
		}),
	});
	expect(response.status).toBe(200);
	expect(response.headers.get("Content-Type")).toBe("audio/wav");
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(wav());
	expect(h.settings.get()).toEqual(before);
	expect(
		h.inference.usage().some((r) => r.purpose === "tts" && r.accepted),
	).toBe(true);
});
