import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { VoiceDialogueClient } from "../../../../../client/voice-dialogue";
import type { RunSpeechEvent } from "../../../../../api/domains/voice-dialogue/contracts";
import type { OutputController } from "../../audio";
import { useReplay } from "../hooks/replay";

afterEach(cleanup);
function fixture() {
	let receive!: (event: RunSpeechEvent) => void;
	let fail!: (error: Error) => void;
	let inputSignal!: AbortSignal;
	const client = {
		watchRunSpeech: vi.fn(
			(
				_run: string,
				_screen: string,
				signal: AbortSignal,
				push: typeof receive,
			) => {
				receive = push;
				inputSignal = signal;
				return new Promise<void>((_resolve, reject) => {
					fail = reject;
				});
			},
		),
		runSpeechPlayed: vi.fn(async () => ({ ok: true })),
	} as unknown as VoiceDialogueClient;
	type Options = NonNullable<Parameters<OutputController["play"]>[2]>;
	const playing: Array<{ ended: () => void; options: Options }> = [];
	const output = {
		startOutput: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		stopPlayback: vi.fn(() => playing.at(-1)?.options.onInterrupted?.()),
		play: vi.fn(
			async (_wav: Uint8Array, ended: () => void, options: Options = {}) => {
				if (options.shouldPlay?.() === false) return;
				playing.push({ ended, options });
				options.onStarted?.();
			},
		),
	};
	const hook = renderHook(() =>
		useReplay(client, {}, { createOutput: () => output }),
	);
	const source = hook.result.current.prepareStream("run", "screen");
	const identity = { runId: "run", sessionId: "session" };
	const generation = (generationId = "generation") =>
		receive({ ...identity, type: "generation", generationId });
	const audio = (index: number, generationId = "generation") =>
		receive({
			...identity,
			type: "audio",
			generationId,
			index,
			text: `${index}。`,
			wav: btoa("wav"),
		});
	const finish = () => receive({ ...identity, type: "finished" });
	generation();
	return {
		hook,
		source,
		client,
		output,
		playing,
		audio,
		generation,
		finish,
		fail,
		signal: () => inputSignal,
	};
}

test("audio arrives while the first clause plays; the next starts only at ended without waiting for the receipt", async () => {
	const f = fixture();
	let acknowledge!: () => void;
	vi.mocked(f.client.runSpeechPlayed).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				acknowledge = () => resolve({ ok: true });
			}),
	);
	f.audio(0);
	expect(await f.source.ready).toBe(true);
	let done!: Promise<void>;
	act(() => {
		done = f.hook.result.current.playStream(f.source);
	});
	await waitFor(() => expect(f.playing).toHaveLength(1));
	f.audio(1);
	await act(async () => {});
	expect(f.playing).toHaveLength(1);
	expect(f.client.runSpeechPlayed).not.toHaveBeenCalled();
	act(() => f.playing[0]!.ended());
	expect(f.hook.result.current.avatarCue).toMatchObject({
		key: "stream:run:0",
		gestureKey: "run:run",
		speaking: false,
	});
	await waitFor(() => expect(f.playing).toHaveLength(2));
	expect(f.client.runSpeechPlayed).toHaveBeenCalledTimes(1);
	expect(f.playing.map((p) => p.options.waitForPrevious)).toEqual([true, true]);
	expect(f.hook.result.current.subtitle).toBe("1。");
	await act(async () => {
		acknowledge();
		f.playing[1]!.ended();
		f.finish();
		await done;
	});
	expect(f.client.runSpeechPlayed).toHaveBeenCalledTimes(2);
	expect(f.hook.result.current.playingId).toBeNull();
	expect(f.hook.result.current.avatarCue).toBeNull();
});

test("generation replacement clears a gesture held while a buffered clause waits to start", async () => {
	const f = fixture();
	f.audio(0);
	f.audio(1);
	let done!: Promise<void>;
	act(() => {
		done = f.hook.result.current.playStream(f.source);
	});
	await waitFor(() => expect(f.playing).toHaveLength(1));
	f.output.play.mockImplementationOnce(() => new Promise(() => {}));
	act(() => f.playing[0]!.ended());
	await waitFor(() => expect(f.output.play).toHaveBeenCalledTimes(2));
	expect(f.hook.result.current.avatarCue?.speaking).toBe(false);
	act(() => f.generation("replacement"));
	expect(f.hook.result.current.avatarCue).toBeNull();
	await act(async () => {
		f.finish();
		await done;
	});
});

test("generation replacement interrupts old playback, discards queued audio and only acknowledges the new generation", async () => {
	const f = fixture();
	f.audio(0);
	f.audio(1);
	let done!: Promise<void>;
	act(() => {
		done = f.hook.result.current.playStream(f.source);
	});
	await waitFor(() => expect(f.playing).toHaveLength(1));
	act(() => {
		f.generation("replacement");
		f.audio(2, "replacement");
	});
	await waitFor(() => expect(f.playing).toHaveLength(2));
	expect(f.output.stopPlayback).toHaveBeenCalledOnce();
	expect(f.playing[0]!.options.shouldPlay?.()).toBe(false);
	expect(f.hook.result.current.subtitle).toBe("2。");
	expect(f.client.runSpeechPlayed).not.toHaveBeenCalled();
	await act(async () => {
		f.playing[1]!.ended();
		f.finish();
		await done;
	});
	expect(f.client.runSpeechPlayed).toHaveBeenCalledWith(
		"run",
		"session",
		expect.objectContaining({
			generationId: "replacement",
			index: 2,
			audible: true,
		}),
		expect.any(AbortSignal),
	);
});

for (const mode of ["stop", "failure"] as const)
	test(`${mode} stops playback and drops buffered and late audio`, async () => {
		const f = fixture();
		f.audio(0);
		f.audio(1);
		let done!: Promise<void>;
		act(() => {
			done = f.hook.result.current.playStream(f.source);
		});
		await waitFor(() => expect(f.playing).toHaveLength(1));
		await act(async () => {
			if (mode === "stop") f.hook.result.current.stopAutomatic();
			else f.fail(new Error("tts_failed"));
			await done;
		});
		f.audio(2);
		await act(async () => {});
		expect(f.output.stopPlayback).toHaveBeenCalled();
		expect(f.signal().aborted).toBe(true);
		expect(f.playing).toHaveLength(1);
		expect(f.hook.result.current.subtitle).toBeNull();
		expect(f.client.runSpeechPlayed).not.toHaveBeenCalled();
	});

test("stopping synthesis before the first result discards late audio without opening output", async () => {
	const f = fixture();
	f.source.stop();
	f.audio(0);
	expect(await f.source.ready).toBe(false);
	expect(await f.source.next()).toBeNull();
	expect(f.output.startOutput).not.toHaveBeenCalled();
});

test("finished before the last receipt response does not abort an accepted report", async () => {
	const f = fixture();
	let complete!: () => void;
	let receiptSignal: AbortSignal | undefined;
	vi.mocked(f.client.runSpeechPlayed).mockImplementationOnce(
		(_run, _session, _value, signal) => {
			receiptSignal = signal;
			return new Promise((resolve) => {
				complete = () => resolve({ ok: true });
			});
		},
	);
	f.audio(0);
	let done!: Promise<void>;
	act(() => {
		done = f.hook.result.current.playStream(f.source);
	});
	await waitFor(() => expect(f.playing).toHaveLength(1));
	act(() => f.playing[0]!.ended());
	await waitFor(() => expect(f.client.runSpeechPlayed).toHaveBeenCalledOnce());
	await act(async () => {
		f.finish();
		await done;
	});
	expect(f.signal().aborted).toBe(true);
	expect(receiptSignal?.aborted).toBe(false);
	expect(f.hook.result.current.playingId).toBeNull();
	complete();
});

test("cancellation aborts an outstanding playback report", async () => {
	const f = fixture();
	let receiptSignal: AbortSignal | undefined;
	vi.mocked(f.client.runSpeechPlayed).mockImplementationOnce(
		(_run, _session, _value, signal) => {
			receiptSignal = signal;
			return new Promise((_resolve, reject) =>
				signal?.addEventListener(
					"abort",
					() => reject(new Error("cancelled")),
					{ once: true },
				),
			);
		},
	);
	f.audio(0);
	let done!: Promise<void>;
	act(() => {
		done = f.hook.result.current.playStream(f.source);
	});
	await waitFor(() => expect(f.playing).toHaveLength(1));
	act(() => f.playing[0]!.ended());
	await waitFor(() => expect(f.client.runSpeechPlayed).toHaveBeenCalledOnce());
	await act(async () => {
		f.hook.result.current.stopAutomatic();
		await done;
	});
	expect(receiptSignal?.aborted).toBe(true);
});
