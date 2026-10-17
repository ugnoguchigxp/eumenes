import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MusicPlayer, type MusicPlayerProps } from "./MusicPlayer";

const track = { id: "one", title: "試験曲", src: "blob:one" };
beforeEach(() => {
	vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
		this: HTMLMediaElement,
	) {
		Object.defineProperty(this, "paused", { configurable: true, value: false });
		this.dispatchEvent(new Event("play"));
		return Promise.resolve();
	});
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
		this: HTMLMediaElement,
	) {
		Object.defineProperty(this, "paused", { configurable: true, value: true });
		this.dispatchEvent(new Event("pause"));
	});
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
function setup(props: Partial<MusicPlayerProps> = {}) {
	const result = render(<MusicPlayer track={track} {...props} />);
	const audio = result.container.querySelector("audio");
	if (!audio) throw new Error("audio missing");
	Object.defineProperty(audio, "duration", { configurable: true, value: 30 });
	fireEvent.durationChange(audio);
	return { ...result, audio };
}
describe("MusicPlayer", () => {
	it("plays, pauses and changes actual media volume", async () => {
		const { audio } = setup();
		fireEvent.click(screen.getByRole("button", { name: "再生" }));
		await screen.findByRole("button", { name: "一時停止" });
		expect(audio.paused).toBe(false);
		fireEvent.click(screen.getByRole("button", { name: "一時停止" }));
		expect(audio.paused).toBe(true);
		fireEvent.change(screen.getByRole("slider", { name: "音量" }), {
			target: { value: "0.3" },
		});
		expect(audio.volume).toBe(0.3);
	});
	it("keeps playing after the playing intent is recorded", async () => {
		const { audio } = setup();
		fireEvent.click(screen.getByRole("button", { name: "再生" }));
		await screen.findByRole("button", { name: "一時停止" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(audio.paused).toBe(false);
		expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
		expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
	});
	it("seeks and clamps ten second jumps to media boundaries", () => {
		const { audio } = setup();
		fireEvent.change(screen.getByRole("slider", { name: "再生位置" }), {
			target: { value: "25" },
		});
		expect(audio.currentTime).toBe(25);
		fireEvent.click(screen.getByRole("button", { name: "10秒スキップ" }));
		expect(audio.currentTime).toBe(30);
		fireEvent.click(screen.getByRole("button", { name: "10秒巻き戻し" }));
		expect(audio.currentTime).toBe(20);
		audio.currentTime = 3;
		fireEvent.timeUpdate(audio);
		fireEvent.click(screen.getByRole("button", { name: "10秒巻き戻し" }));
		expect(audio.currentTime).toBe(0);
	});
	it("disables missing neighbours and unknown duration", () => {
		render(<MusicPlayer track={track} />);
		for (const name of ["前の楽曲", "次の楽曲", "10秒スキップ"])
			expect(screen.getByRole("button", { name })).toBeDisabled();
		expect(screen.getByRole("slider", { name: "再生位置" })).toBeDisabled();
	});
	it("selects neighbours and replaces the media, retaining playing intent", async () => {
		const next = vi.fn(),
			previous = vi.fn();
		const { container, rerender } = render(
			<MusicPlayer track={track} onPrevious={previous} onNext={next} />,
		);
		const old = container.querySelector("audio");
		if (!old) throw new Error("audio missing");
		fireEvent.click(screen.getByRole("button", { name: "再生" }));
		await screen.findByRole("button", { name: "一時停止" });
		fireEvent.click(screen.getByRole("button", { name: "前の楽曲" }));
		fireEvent.click(screen.getByRole("button", { name: "次の楽曲" }));
		expect(previous).toHaveBeenCalledOnce();
		expect(next).toHaveBeenCalledOnce();
		rerender(<MusicPlayer track={{ ...track, id: "two", src: "blob:two" }} />);
		expect(old.paused).toBe(true);
		await waitFor(() =>
			expect(container.querySelector("audio")?.paused).toBe(false),
		);
		expect(container.querySelector("audio")?.currentTime).toBe(0);
	});
	it("reports a rejected play without pretending playback started", async () => {
		vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(
			new Error("blocked"),
		);
		setup();
		fireEvent.click(screen.getByRole("button", { name: "再生" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"再生できません",
		);
		expect(screen.getByRole("button", { name: "再生" })).toBeEnabled();
	});
	it("retains playback intent while the host loads the next selected track", async () => {
		const { container, rerender } = setup();
		fireEvent.click(screen.getByRole("button", { name: "再生" }));
		await screen.findByRole("button", { name: "一時停止" });
		rerender(<MusicPlayer track={null} loading />);
		expect(container.querySelector("audio")).toBeNull();
		rerender(<MusicPlayer track={{ ...track, id: "two", src: "blob:two" }} />);
		await waitFor(() =>
			expect(container.querySelector("audio")?.paused).toBe(false),
		);
	});
	it("keeps native playback available when audio analysis is unsupported", async () => {
		vi.stubGlobal("AudioContext", undefined);
		const changed = vi.fn();
		const { audio } = setup({ onPlaybackChange: changed });
		fireEvent.click(screen.getByRole("button", { name: "再生" }));
		await waitFor(() =>
			expect(changed).toHaveBeenCalledWith(
				expect.objectContaining({
					playing: true,
					analysisError: true,
					analyser: null,
				}),
			),
		);
		expect(audio.paused).toBe(false);
	});
	it("does not route media into a context that fails to resume", async () => {
		const source = vi.fn();
		const close = vi.fn(async () => {});
		vi.stubGlobal(
			"AudioContext",
			class {
				state = "suspended";
				resume = vi.fn(async () => {
					throw new Error("blocked");
				});
				close = close;
				createMediaElementSource = source;
			},
		);
		const { audio } = setup({ onPlaybackChange: vi.fn() });
		fireEvent.click(screen.getByRole("button", { name: "再生" }));
		await screen.findByRole("button", { name: "一時停止" });
		expect(audio.paused).toBe(false);
		expect(source).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalled();
	});
});
