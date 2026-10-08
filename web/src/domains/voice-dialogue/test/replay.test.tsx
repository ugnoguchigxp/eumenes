import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
	voiceDialogueClient,
	type VoiceDialogueClient,
} from "../../../../../client/voice-dialogue";
import { useReplay } from "../hooks/replay";

class FakeAudio {
	static instances: FakeAudio[] = [];
	volume = 1;
	onplaying: (() => void) | null = null;
	onended: (() => void) | null = null;
	onerror: (() => void) | null = null;
	play = vi.fn(async () => {});
	pause = vi.fn();
	constructor(_url: string) {
		FakeAudio.instances.push(this);
	}
}
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});
function fixture(volume = 1) {
	FakeAudio.instances = [];
	vi.stubGlobal("Audio", FakeAudio);
	vi.stubGlobal("URL", {
		createObjectURL: () => "blob:fixture",
		revokeObjectURL: vi.fn(),
	});
	const client = {
		replaySentences: async () => ["句。"],
		replaySpeech: async () => ({ wav: new Uint8Array(44), motion: "joyful" }),
	} as unknown as VoiceDialogueClient;
	return renderHook(() => useReplay(client, volume));
}

test("replay starts the selected emotion only on playing and fences cancelled events", async () => {
	const hook = fixture();
	let first!: Promise<void>, second!: Promise<void>;
	act(() => {
		first = hook.result.current.play("one", "一。");
	});
	await waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
	const old = FakeAudio.instances[0]!;
	expect(hook.result.current.avatarCue).toBeNull();
	act(() => old.onplaying?.());
	expect(hook.result.current.avatarCue).toMatchObject({
		motion: "joyful",
		speaking: true,
	});
	act(() => hook.result.current.stop());
	expect(hook.result.current.avatarCue).toBeNull();
	act(() => {
		second = hook.result.current.play("two", "二。");
	});
	await waitFor(() => expect(FakeAudio.instances).toHaveLength(2));
	act(() => old.onplaying?.());
	expect(hook.result.current.avatarCue).toBeNull();
	act(() => FakeAudio.instances[1]!.onplaying?.());
	const current = hook.result.current.avatarCue;
	act(() => old.onended?.());
	expect(hook.result.current.avatarCue).toEqual(current);
	await act(async () => {
		FakeAudio.instances[1]!.onended?.();
		await Promise.all([first, second]);
	});
	expect(hook.result.current.avatarCue).toBeNull();
});

test("muted replay does not start a speaking gesture", async () => {
	const hook = fixture(0);
	let finished!: Promise<void>;
	act(() => {
		finished = hook.result.current.play("one", "一。");
	});
	await waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
	act(() => FakeAudio.instances[0]!.onplaying?.());
	expect(hook.result.current.avatarCue).toBeNull();
	await act(async () => {
		FakeAudio.instances[0]!.onended?.();
		await finished;
	});
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
