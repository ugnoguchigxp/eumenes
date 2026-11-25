import { expect, test, spyOn } from "bun:test";
import { Hono } from "hono";
import { createContinuityService } from "../../continuity";
import {
	createSettingsVoiceFixture,
	until,
	wav,
} from "./settings-voice.fixture";
import { registerVoiceDialogue } from "..";
import { errorStatus, type RunSpeechEvent } from "../contracts";
import { voiceDialogueClient } from "../../../../client/voice-dialogue";
import { settle } from "../../../infrastructure/wait-for";
const { setup } = createSettingsVoiceFixture();

async function fixture(
	speak: (
		text: string,
		signal: AbortSignal,
	) => Promise<Uint8Array> = async () => wav(),
	cloud = false,
	adoption?: { complete: boolean },
) {
	let delta: ((text: string) => void) | undefined;
	let resolve!: (text: string) => void;
	let generations = 0;
	let text = "";
	const h = await setup(
		undefined,
		{
			answerStream: async (_messages, _signal, push) => {
				delta = push;
				text = "";
				generations++;
				return new Promise<string>((done) => {
					resolve = done;
				});
			},
			...(cloud ? {} : { speak }),
		},
		undefined,
		adoption
			? {
					replyInputInTransaction: () => ({
						sources: [],
						complete: adoption.complete,
					}),
				}
			: undefined,
	);
	const screenId = crypto.randomUUID();
	h.inference.screenPresence(screenId, 1, true, Date.now(), {
		gestureAgeMs: 0,
	});
	const run = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "返事をお願いします。",
	});
	await until(() => !!delta);
	const app = new Hono();
	app.onError((error) =>
		Response.json(
			{ error: error.message },
			{ status: errorStatus[error.message as keyof typeof errorStatus] ?? 500 },
		),
	);
	registerVoiceDialogue(app, h.voice);
	const client = voiceDialogueClient({
		identity: "fixture",
		call: async (path, init) => {
			const response = await app.request(path, init);
			if (!response.ok)
				throw new Error(((await response.json()) as { error: string }).error);
			return response;
		},
	});
	const frames: RunSpeechEvent[] = [];
	const abort = new AbortController();
	const watching = client.watchRunSpeech(
		run.id,
		screenId,
		abort.signal,
		(value) => frames.push(value),
	);
	watching.catch(() => {});
	await until(() => frames.some((f) => f.type === "generation"));
	const audio = () =>
		frames.filter(
			(f): f is Extract<RunSpeechEvent, { type: "audio" }> =>
				f.type === "audio",
		);
	return {
		h,
		run,
		screenId,
		app,
		client,
		frames,
		abort,
		watching,
		audio,
		generations: () => generations,
		push(value: string) {
			text += value;
			delta!(value);
		},
		finish() {
			resolve(text);
		},
		async played(index: number, audible = true) {
			const chunk = audio().find((f) => f.index === index)!;
			return client.runSpeechPlayed(run.id, chunk.sessionId, {
				screenId,
				generationId: chunk.generationId,
				index,
				audible,
			});
		},
	};
}

test("typed reply streams completed clauses before adoption and flushes its tail once", async () => {
	const calls: string[] = [];
	const f = await fixture(async (text) => {
		calls.push(text);
		return wav();
	});
	try {
		f.push("最初");
		await settle();
		expect(calls).toEqual([]);
		f.push("、");
		await until(() => f.audio().length === 1);
		expect(calls).toEqual(["最初、"]);
		expect(f.h.dialogue.get(f.run.id)?.status).toBe("running");
		expect(f.h.dialogue.answerText(f.run.id)).toBeNull();
		f.push("次。末尾");
		await until(() => f.audio().length === 2);
		await f.played(0);
		f.finish();
		await until(() => f.audio().length === 3);
		expect(calls).toEqual(["最初、", "次。", "末尾"]);
		await f.played(1);
		await f.played(2);
		await f.watching;
		expect(f.frames.at(-1)?.type).toBe("finished");
		expect(f.h.dialogue.get(f.run.id)?.status).toBe("completed");
		expect(f.h.dialogue.answerText(f.run.id)).toBe("最初、次。末尾");
		expect(() =>
			f.h.voice.claimSpeech(f.screenId, `run:${f.run.id}:answer`),
		).toThrow("speech_already_claimed");
	} finally {
		f.abort.abort();
		f.finish();
		await f.watching.catch(() => {});
	}
});

test("typed speech prefetches three clauses and makes room only after playback is acknowledged", async () => {
	const calls: string[] = [];
	const f = await fixture(async (text) => {
		calls.push(text);
		return wav();
	});
	try {
		f.push("一。二。三。四。");
		f.finish();
		await until(() => f.audio().length === 3);
		await settle();
		expect(calls).toEqual(["一。", "二。", "三。"]);
		await f.played(0);
		await until(() => f.audio().length === 4);
		expect(calls).toEqual(["一。", "二。", "三。", "四。"]);
		await f.played(1);
		await f.played(2);
		await f.played(3);
		await f.watching;
	} finally {
		f.abort.abort();
		f.finish();
		await f.watching.catch(() => {});
	}
});

test("cancelling the reply aborts pending synthesis and never publishes its late audio", async () => {
	let signal: AbortSignal | undefined;
	let release!: (bytes: Uint8Array) => void;
	const pending = new Promise<Uint8Array>((done) => {
		release = done;
	});
	const f = await fixture(async (_text, abort) => {
		signal = abort;
		return pending;
	});
	try {
		f.push("取り消します。");
		await until(() => !!signal);
		await f.h.dialogue.cancel(f.run.id);
		await f.watching.catch(() => {});
		expect(signal!.aborted).toBe(true);
		release(wav());
		await settle();
		expect(f.audio()).toEqual([]);
		expect(f.frames.at(-1)?.type).toBe("error");
	} finally {
		release(wav());
		f.abort.abort();
		f.finish();
		await f.watching.catch(() => {});
	}
});

test("another screen, duplicate reader and another generation cannot consume a typed reply", async () => {
	const f = await fixture();
	try {
		const request = (screenId: string) =>
			f.app.request(`/api/voice/runs/${f.run.id}/speech`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ screenId }),
			});
		expect((await request(crypto.randomUUID())).status).toBe(409);
		expect((await request(f.screenId)).status).toBe(409);
		f.push("ひとつ。");
		await until(() => f.audio().length === 1);
		const chunk = f.audio()[0]!;
		await expect(
			f.h.voice.runSpeechPlayed(f.run.id, chunk.sessionId, {
				screenId: f.screenId,
				generationId: crypto.randomUUID(),
				index: 0,
				audible: true,
			}),
		).rejects.toThrow("speech_session_stale");
		f.finish();
		await until(() => f.h.dialogue.get(f.run.id)?.status === "completed");
		await f.played(0);
		await f.watching;
	} finally {
		f.abort.abort();
		f.finish();
		await f.watching.catch(() => {});
	}
});

test("disconnect discards unplayed audio without cancelling the conversation", async () => {
	const f = await fixture();
	const heard = spyOn(f.h.dialogue, "recordHeardInTransaction");
	try {
		f.push("一。二。三。");
		await until(() => f.audio().length === 3);
		await f.played(1);
		await f.played(0);
		await f.played(0); // A duplicate must neither add words nor free an extra slot.
		f.abort.abort();
		await f.watching.catch(() => {});
		expect(f.h.dialogue.get(f.run.id)?.status).toBe("running");
		f.finish();
		await until(() => f.h.dialogue.get(f.run.id)?.status === "completed");
		await until(() => heard.mock.calls.length === 1);
		expect(heard.mock.calls[0]!.slice(1)).toEqual([
			f.run.id,
			"partial",
			"一。二。",
		]);
		// Typed adoption already delivered the whole visible text. Speech receipts must not retract it.
		expect(deliveredFields(f)).toEqual([
			expect.objectContaining({ heard: "full" }),
		]);
	} finally {
		f.abort.abort();
		f.finish();
		await f.watching.catch(() => {});
	}
});

test("playback ownership loss closes the stream even with no new text or database writes", async () => {
	const f = await fixture();
	try {
		f.push("待機する音声。");
		await until(() => f.audio().length === 1);
		f.h.inference.screenPresence(f.screenId, 2, false, Date.now(), {
			leaving: true,
		});
		await until(() => f.frames.at(-1)?.type === "error");
		await f.watching.catch(() => {});
		await expect(f.played(0)).rejects.toThrow("speech_session_stale");
	} finally {
		f.abort.abort();
		f.finish();
		await f.watching.catch(() => {});
	}
});

test("revoking TTS settings invalidates audio already waiting for playback", async () => {
	const f = await fixture(undefined, true);
	try {
		f.push("待機する音声。");
		await until(() => f.audio().length === 1);
		const settings = f.h.settings.get();
		settings.routes.tts.cloudAllowed = false;
		settings.routes.tts.mode = "larm-only";
		await f.h.settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: settings.revision,
			settings,
			keys: [],
		});
		await until(() => f.frames.at(-1)?.type === "error");
		await f.watching.catch(() => {});
		await expect(f.played(0)).rejects.toThrow("speech_session_stale");
	} finally {
		f.abort.abort();
		f.finish();
		await f.watching.catch(() => {});
	}
});

test("one failed clause is skipped without a retry, and all failed clauses close only speech", async () => {
	for (const all of [false, true]) {
		const calls: string[] = [];
		const f = await fixture(async (text) => {
			calls.push(text);
			if (all || text === "一。") throw new Error("tts_failed");
			return wav();
		});
		try {
			f.push("一。二。");
			f.finish();
			if (!all) {
				await until(() => f.audio().length === 1);
				expect(f.audio()[0]!.index).toBe(1);
				await f.played(1);
			}
			await f.watching.catch(() => {});
			expect(calls).toEqual(["一。", "二。"]);
			expect(f.frames.at(-1)?.type).toBe(all ? "error" : "finished");
			expect(f.h.dialogue.get(f.run.id)?.status).toBe("completed");
		} finally {
			f.abort.abort();
			f.finish();
			await f.watching.catch(() => {});
		}
	}
});

function deliveredFields(f: Awaited<ReturnType<typeof fixture>>) {
	return f.h.store
		.read((db) => createContinuityService().events.logInTransaction(db, "main"))
		.filter((event) => event.type === "delivered")
		.map((event) => JSON.parse(event.text ?? "{}"));
}

test("adoption retry replaces the generation, discards unplayed old audio and rejects its late receipt", async () => {
	const adoption = { complete: false };
	const f = await fixture(undefined, false, adoption);
	try {
		f.push("古い一。古い二。");
		await until(() => f.audio().length === 2);
		const old = f.audio()[1]!;
		await f.played(0);
		f.finish();
		await until(() => f.generations() === 2);
		adoption.complete = true;
		f.push("新しい回答。");
		await until(() => f.audio().length === 3);
		const next = f.audio()[2]!;
		expect(next.generationId).not.toBe(old.generationId);
		expect(next.index).toBeGreaterThan(old.index);
		await expect(f.played(old.index)).rejects.toThrow("speech_session_stale");
		f.finish();
		await f.played(next.index);
		await f.watching;
		expect(f.h.dialogue.answerText(f.run.id)).toBe("新しい回答。");
	} finally {
		f.abort.abort();
		f.finish();
		await f.watching.catch(() => {});
	}
});

test("a failed receipt writer never consumes or records a clause", async () => {
	const f = await fixture();
	try {
		f.push("一。二。三。四。");
		await until(() => f.audio().length === 3);
		const write = spyOn(f.h.store, "write").mockRejectedValueOnce(
			new Error("writer_busy"),
		);
		try {
			await expect(f.played(0)).rejects.toThrow("writer_busy");
		} finally {
			write.mockRestore();
		}
		await settle();
		expect(f.audio()).toHaveLength(3);
		await f.played(0);
		await until(() => f.audio().length === 4);
		f.finish();
		await f.played(1);
		await f.played(2);
		await f.played(3);
		await f.watching;
	} finally {
		f.abort.abort();
		f.finish();
		await f.watching.catch(() => {});
	}
});
