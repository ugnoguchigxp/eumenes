import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
	voiceDialogueClient,
	type VoiceDialogueClient,
} from "../../../../../client/voice-dialogue";
import type { OutputController } from "../../audio";
import { useReplay } from "../hooks/replay";

type PlayOptions = NonNullable<Parameters<OutputController["play"]>[2]>;
type Played = { onEnded: () => void; options: PlayOptions };
function fakeOutput() {
	const played: Played[] = [];
	const output = {
		startOutput: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		stopPlayback: vi.fn(() => {
			// Like the real controller: the current playback is cut off.
			played.at(-1)?.options.onInterrupted?.();
		}),
		play: vi.fn(
			async (
				_bytes: Uint8Array,
				onEnded: () => void,
				options: PlayOptions = {},
			) => {
				if (options.shouldPlay?.() === false) return;
				played.push({ onEnded, options });
				options.onStarted?.();
			},
		),
	};
	return { output, played };
}
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});
function fixture(
	settings: { outputVolume?: number; outputDevice?: string } = {},
) {
	const fake = fakeOutput();
	const client = {
		replaySentences: async () => ["句。"],
		replaySpeech: async () => ({ wav: new Uint8Array(44), motion: "joyful" }),
	} as unknown as VoiceDialogueClient;
	const createOutput = vi.fn((_device: string) => fake.output);
	const hook = renderHook(() => useReplay(client, settings, { createOutput }));
	return { hook, createOutput, ...fake };
}

test("replay plays through the audio controller with the output device and volume", async () => {
	const { hook, createOutput, output, played } = fixture({
		outputVolume: 0.5,
		outputDevice: "speaker-2",
	});
	let done!: Promise<void>;
	act(() => {
		done = hook.result.current.play("one", "一。");
	});
	await waitFor(() => expect(played).toHaveLength(1));
	expect(createOutput).toHaveBeenCalledWith("speaker-2");
	expect(output.startOutput).toHaveBeenCalledOnce();
	expect(played[0]!.options.volume).toBe(0.5);
	expect(hook.result.current.avatarCue).toMatchObject({
		motion: "joyful",
		speaking: true,
	});
	await act(async () => {
		played[0]!.onEnded();
		await done;
	});
	expect(hook.result.current.avatarCue).toBeNull();
	expect(hook.result.current.playingId).toBeNull();
});

test("a newer replay discards the old playback and fences its events", async () => {
	const { hook, played } = fixture();
	let first!: Promise<void>, second!: Promise<void>;
	act(() => {
		first = hook.result.current.play("one", "一。");
	});
	await waitFor(() => expect(played).toHaveLength(1));
	const old = played[0]!;
	act(() => {
		second = hook.result.current.play("two", "二。");
	});
	await waitFor(() => expect(played).toHaveLength(2));
	expect(old.options.shouldPlay?.()).toBe(false);
	const current = hook.result.current.avatarCue;
	act(() => old.onEnded());
	expect(hook.result.current.avatarCue).toEqual(current);
	await act(async () => {
		played[1]!.onEnded();
		await Promise.all([first, second]);
	});
	expect(hook.result.current.avatarCue).toBeNull();
});

test("muted replay does not start a speaking gesture", async () => {
	const { hook, played } = fixture({ outputVolume: 0 });
	let finished!: Promise<void>;
	act(() => {
		finished = hook.result.current.play("one", "一。");
	});
	await waitFor(() => expect(played).toHaveLength(1));
	expect(hook.result.current.avatarCue).toBeNull();
	await act(async () => {
		played[0]!.onEnded();
		await finished;
	});
});

test("replay shares the live session controller and interrupts the live reply first", async () => {
	const fake = fakeOutput();
	const interruptLive = vi.fn();
	const client = {
		replaySentences: async () => ["句。"],
		replaySpeech: async () => ({ wav: new Uint8Array(44), motion: "neutral" }),
	} as unknown as VoiceDialogueClient;
	const createOutput = vi.fn();
	const hook = renderHook(() =>
		useReplay(
			client,
			{},
			{ sessionAudio: () => fake.output, interruptLive, createOutput },
		),
	);
	let done!: Promise<void>;
	act(() => {
		done = hook.result.current.play("one", "一。");
	});
	await waitFor(() => expect(fake.played).toHaveLength(1));
	expect(interruptLive).toHaveBeenCalledOnce();
	expect(createOutput).not.toHaveBeenCalled();
	// Barge-in on the live controller cuts the replay and ends it.
	await act(async () => {
		fake.output.stopPlayback();
		await done;
	});
	expect(hook.result.current.playingId).toBeNull();
});

test("replay transport accepts the motion header and safely falls back on unknown labels", async () => {
	for (const [header, expected] of [
		["joyful", "joyful"],
		["invented", "neutral"],
	]) {
		const client = voiceDialogueClient({
			identity: "fixture",
			call: async () =>
				new Response(new Uint8Array(44), {
					headers: { "X-Avatar-Motion": header! },
				}),
		});
		expect((await client.replaySpeech("句。")).motion).toBe(expected);
	}
});
