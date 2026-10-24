import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, orderMigrations } from "../../../infrastructure/sqlite";
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
	type GoalsLayerPort,
	migrations as dialogueMigrations,
} from "../../dialogue";
import { createQueue, migrations as queueMigrations } from "../../queue";
import { migrations as schedulerMigrations } from "../../scheduler";
import {
	createSettings,
	migrations as settingsMigrations,
} from "../../settings";
import {
	createInference,
	migrations as inferenceMigrations,
} from "../../inference";
import { createVoiceDialogue, migrations as voiceMigrations } from "..";
import type { LarmCallOptions, LarmPort } from "../../larm";
import type { NativeToolCall } from "../../../infrastructure/chat-stream";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});
/** The analysis a user's new utterance ends with: a plain answer that needs no basis. */
const RESPOND_ARGS = {
	kind: "chat",
	freshness: "not_live",
	impact: "none",
	approved: false,
};

/**
 * A chat completion that says `text`. When the request offers the `respond` tool, as every generation does,
 * the completion also calls it, as the conversation model must for a user's utterance.
 */
function offersRespond(init: RequestInit | undefined) {
	const body =
		typeof init?.body === "string"
			? (JSON.parse(init.body) as {
					tools?: Array<{ function?: { name?: string } }>;
				})
			: {};
	return (body.tools ?? []).some((tool) => tool.function?.name === "respond");
}
const RESPOND_CALL = {
	id: "call-respond",
	type: "function",
	function: { name: "respond", arguments: JSON.stringify(RESPOND_ARGS) },
};
/**
 * The local model reports its `respond` call through `onToolCalls`, as the cloud one does in its completion;
 * call it once the answer is complete, when the request offers that tool.
 */
export function reportRespond(options?: LarmCallOptions) {
	if (!options?.tools?.some((tool) => tool.function.name === "respond")) return;
	const call: NativeToolCall = {
		id: "call-respond",
		name: "respond",
		arguments: JSON.stringify(RESPOND_ARGS),
	};
	options.onToolCalls?.([call]);
}

export function completion(init: RequestInit | undefined, text: string) {
	const offered = offersRespond(init);
	return {
		choices: [
			{
				index: 0,
				message: {
					content: text,
					...(offered ? { tool_calls: [RESPOND_CALL] } : {}),
				},
				finish_reason: offered ? "tool_calls" : "stop",
			},
		],
	};
}

/** The stream frame that ends a streamed completion with the `respond` call, when the request offers it. */
export function respondFrame(init: RequestInit | undefined) {
	if (!offersRespond(init)) return "";
	const frame = {
		choices: [
			{
				index: 0,
				delta: {
					tool_calls: [{ index: 0, ...RESPOND_CALL }],
				},
				finish_reason: "tool_calls",
			},
		],
	};
	return `data: ${JSON.stringify(frame)}\n\n`;
}

export function wav() {
	const b = new Uint8Array(48);
	b.set(new TextEncoder().encode("RIFF"));
	b.set(new TextEncoder().encode("WAVE"), 8);
	return b;
}
/** Fixture language judgment: Latin text is English, anything else Japanese. */
function judgeLanguage(
	messages: Array<{ content: string }>,
	judge: (text: string) => string[] = (text) => [
		/[A-Za-z]/.test(text) ? "en" : "ja",
	],
) {
	if (!messages[0]?.content.includes("音声認識（ASR）が書き起こした文の言語"))
		return null;
	const { text } = JSON.parse(messages.at(-1)!.content) as { text: string };
	return JSON.stringify({ languages: judge(text) });
}
export async function setup(
	fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
	local: Partial<LarmPort> = {},
	judge?: (text: string) => string[],
	goals?: GoalsLayerPort,
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-settings-voice-"));
	const dbPath = join(dir, "test.db");
	const store = openStore(
		dbPath,
		orderMigrations([
			...conversationMigrations,
			...queueMigrations,
			...schedulerMigrations,
			...continuityMigrations,
			...dialogueMigrations,
			...voiceMigrations,
			...settingsMigrations,
			...inferenceMigrations,
		]),
	);
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
			contextWindow: p === "llm" ? 262144 : null,
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
	const defaultFetch = async (url: unknown, init?: RequestInit) => {
		calls.push(String(url));
		return String(url).endsWith("audio/transcriptions")
			? Response.json({ text: "fixture speech" })
			: String(url).endsWith("audio/speech")
				? new Response(wav())
				: Response.json(completion(init, "fixture answer"));
	};
	const inference = createInference(store, settings, {
		fetch: async (input, init) => {
			const judged =
				typeof init?.body === "string" &&
				judgeLanguage(JSON.parse(init.body).messages ?? [], judge);
			if (judged)
				return Response.json({
					choices: [{ message: { content: judged } }],
				});
			return (fetcher ?? defaultFetch)(input, init);
		},
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
			answer: async (messages, signal, options) => {
				const judged = judgeLanguage(messages, judge);
				if (judged) return judged;
				if (!local.answer) throw new Error("larm_unconfigured");
				const text = await local.answer(messages, signal, options);
				reportRespond(options);
				return text;
			},
		}),
	});
	const conversation = createConversationService(store);
	const queue = createQueue(store, { pollMs: 5 });
	const continuity = createContinuityService(store);
	const dialogue = createDialogueService({
		store,
		conversation,
		continuity,
		larm: inference,
		queue,
		goals,
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
export async function until(condition: () => boolean) {
	for (let i = 0; i < 300; i++) {
		if (condition()) return;
		await Bun.sleep(5);
	}
	throw new Error("condition_not_reached");
}
/** Uploads one segment and sends it once transcribed, as the Web does when the speaker is idle. */
export async function say(
	h: Awaited<ReturnType<typeof setup>>,
	session: string,
	id: string,
) {
	await h.voice.accept(session, 1, 1, id, wav());
	await until(() => h.voice.get(id)?.status !== "recognizing");
	const turn = h.voice.get(id)!;
	if (turn.status === "input_ready") await h.voice.commit(id, turn.revision);
}
