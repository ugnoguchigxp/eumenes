import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SamplePlayer } from "./shared";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function setup() {
	const create = vi.fn(() => "blob:sample");
	const revoke = vi.fn();
	Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
	vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
	const client = {
		voiceSample: vi.fn(async () => new Uint8Array([1, 2, 3])),
	};
	const view = render(
		<SamplePlayer client={client as never} voice={{} as never} />,
	);
	return { revoke, view };
}

test("stopping playback revokes the blob URL", async () => {
	const { revoke } = setup();
	fireEvent.click(screen.getByText("サンプルを再生"));
	fireEvent.click(await screen.findByText("サンプルを停止"));
	expect(revoke).toHaveBeenCalledWith("blob:sample");
});

test("unmounting during playback revokes the blob URL", async () => {
	const { revoke, view } = setup();
	fireEvent.click(screen.getByText("サンプルを再生"));
	await screen.findByText("サンプルを停止");
	view.unmount();
	expect(revoke).toHaveBeenCalledWith("blob:sample");
});

test("a late sample after closing or changing voice is discarded, even if transport ignores abort", async () => {
	const create = vi.fn(() => "blob:late");
	Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
	let resolve!: (bytes: Uint8Array) => void;
	const client = {
		identity: "sample-cancel",
		voiceSample: vi.fn(
			(_voice: unknown, _signal?: AbortSignal) =>
				new Promise<Uint8Array>((r) => {
					resolve = r;
				}),
		),
	};
	const view = render(
		<SamplePlayer client={client as never} voice={{ voice: "old" }} />,
	);
	fireEvent.click(screen.getByText("サンプルを再生"));
	const signal = client.voiceSample.mock.calls[0]?.[1] as
		| AbortSignal
		| undefined;
	view.rerender(
		<SamplePlayer client={client as never} voice={{ voice: "new" }} />,
	);
	expect(signal?.aborted).toBe(true);
	resolve(new Uint8Array([1]));
	await new Promise((r) => setTimeout(r, 0));
	expect(create).not.toHaveBeenCalled();
	expect(screen.getByText("サンプルを再生")).toBeTruthy();
});

test("failed browser playback releases its URL and audio", async () => {
	const { revoke } = setup();
	vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValueOnce(
		new Error("blocked"),
	);
	fireEvent.click(screen.getByText("サンプルを再生"));
	await screen.findByRole("alert");
	expect(revoke).toHaveBeenCalledWith("blob:sample");
});

test("sample output selection and live volume use the same audio; stopping during sink selection prevents late playback", async () => {
	const { act, renderHook, waitFor } = await import("@testing-library/react");
	const { useVoiceSample } = await import("./useVoiceSample");
	const create = vi.fn(() => "blob:sink"),
		revoke = vi.fn();
	Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
	let finish!: () => void;
	const sink = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	const play = vi.fn(async () => {}),
		pause = vi.fn();
	const audios: { volume: number }[] = [];
	class AudioFixture {
		volume = 1;
		onended = null;
		onerror = null;
		play = play;
		pause = pause;
		setSinkId = sink;
		constructor(_src?: string) {
			audios.push(this);
		}
		removeAttribute() {}
	}
	vi.stubGlobal("Audio", AudioFixture);
	const client = {
		identity: "output-test",
		voiceSample: async () => new Uint8Array([1, 2, 3]),
	};
	const hook = renderHook(
		({ volume }) =>
			useVoiceSample(
				client as never,
				{ voice: "same" },
				false,
				volume,
				"speaker-test",
			),
		{ initialProps: { volume: 0.8 } },
	);
	let pending!: Promise<void>;
	act(() => {
		pending = hook.result.current.play();
	});
	await waitFor(() => expect(sink).toHaveBeenCalledWith("speaker-test"));
	hook.rerender({ volume: 0.4 });
	expect(audios[0]?.volume).toBe(0.4);
	act(() => hook.result.current.stop());
	await act(async () => {
		finish();
		await pending;
	});
	expect(play).not.toHaveBeenCalled();
	expect(pause).toHaveBeenCalled();
	expect(revoke).toHaveBeenCalledWith("blob:sink");
	hook.unmount();
	vi.unstubAllGlobals();
});
