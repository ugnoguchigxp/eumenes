import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MusicPlayer, type MusicPlayerProps } from "./MusicPlayer";
import { requestPlayback } from "./playbackRequest";
import { StrictMode, useEffect } from "react";

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
	it("keeps a host's start playing through StrictMode replay and stops on real unmount", async () => {
		function Host({ ready }: { ready: boolean }) {
			useEffect(() => {
				if (ready) void requestPlayback(track.id, 0);
			}, [ready]);
			return <MusicPlayer track={ready ? track : null} />;
		}
		const view = render(
			<StrictMode>
				<Host ready={false} />
			</StrictMode>,
		);
		view.rerender(
			<StrictMode>
				<Host ready />
			</StrictMode>,
		);
		const audio = view.container.querySelector("audio")!;
		await screen.findByRole("button", { name: "一時停止" });
		expect(audio.paused).toBe(false);
		expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
		view.unmount();
		await waitFor(() => expect(audio.paused).toBe(true));
	});
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
	it.each([0, 0.3])(
		"retains volume %s across track and source changes without changing other audio",
		(volume) => {
			const speech = document.createElement("audio");
			speech.volume = 0.7;
			const { container, rerender } = setup();
			fireEvent.change(screen.getByRole("slider", { name: "音量" }), {
				target: { value: String(volume) },
			});
			for (const next of [
				{ ...track, id: "two", src: "blob:two" },
				{ ...track, id: "two", src: "blob:refreshed" },
				track,
			]) {
				rerender(<MusicPlayer track={next} />);
				expect(container.querySelector("audio")?.volume).toBe(volume);
				expect(screen.getByRole("slider", { name: "音量" })).toHaveValue(
					String(volume),
				);
				expect(speech.volume).toBe(0.7);
			}
		},
	);
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
	it("advances on end and keeps playing the next track", async () => {
		const ended = vi.fn();
		const { audio, container, rerender } = setup({ onEnded: ended });
		fireEvent.change(screen.getByRole("slider", { name: "音量" }), {
			target: { value: "0.25" },
		});
		fireEvent.click(screen.getByRole("button", { name: "再生" }));
		await screen.findByRole("button", { name: "一時停止" });
		Object.defineProperty(audio, "ended", { configurable: true, value: true });
		act(() => audio.pause());
		fireEvent.ended(audio);
		expect(ended).toHaveBeenCalledOnce();
		vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(function (
			this: HTMLMediaElement,
		) {
			expect(this.volume).toBe(0.25);
			Object.defineProperty(this, "paused", {
				configurable: true,
				value: false,
			});
			this.dispatchEvent(new Event("play"));
			return Promise.resolve();
		});
		rerender(
			<MusicPlayer
				track={{ ...track, id: "two", src: "blob:two" }}
				onEnded={ended}
			/>,
		);
		await waitFor(() =>
			expect(container.querySelector("audio")?.paused).toBe(false),
		);
		expect(container.querySelector("audio")?.volume).toBe(0.25);
	});
	it("repeats the current track across track changes", () => {
		const { audio, container, rerender } = setup();
		expect(audio.loop).toBe(false);
		const toggle = screen.getByRole("button", { name: "1曲リピート" });
		expect(toggle).toHaveAttribute("aria-pressed", "false");
		fireEvent.click(toggle);
		expect(toggle).toHaveAttribute("aria-pressed", "true");
		expect(audio.loop).toBe(true);
		rerender(<MusicPlayer track={{ ...track, id: "two", src: "blob:two" }} />);
		expect(container.querySelector("audio")?.loop).toBe(true);
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
		const audio = container.querySelector("audio")!;
		act(() => {
			audio.volume = 0.4;
		});
		fireEvent.volumeChange(audio);
		fireEvent.click(screen.getByRole("button", { name: "再生" }));
		await screen.findByRole("button", { name: "一時停止" });
		rerender(<MusicPlayer track={null} loading />);
		expect(container.querySelector("audio")).toBeNull();
		rerender(<MusicPlayer track={{ ...track, id: "two", src: "blob:two" }} />);
		await waitFor(() =>
			expect(container.querySelector("audio")?.paused).toBe(false),
		);
		expect(container.querySelector("audio")?.volume).toBe(0.4);
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
	it("starts playback from code for the track on screen without a click", async () => {
		const { audio } = setup();
		await act(() => requestPlayback("one"));
		await screen.findByRole("button", { name: "一時停止" });
		expect(audio.paused).toBe(false);
	});
	it("waits for the track's player to mount, and gives up when none does", async () => {
		const pending = requestPlayback("late", 1_000);
		render(<MusicPlayer track={{ ...track, id: "late" }} />);
		await act(async () => {
			await expect(pending).resolves.toBeUndefined();
		});
		await expect(requestPlayback("never", 20)).rejects.toThrow(
			"player_unavailable",
		);
	});
	it("reports a browser refusal as NotAllowedError and asks for a press on the play button", async () => {
		setup();
		vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(
			new DOMException("blocked", "NotAllowedError"),
		);
		await act(async () => {
			await expect(requestPlayback("one")).rejects.toMatchObject({
				name: "NotAllowedError",
			});
		});
		const play = await screen.findByRole("button", { name: "再生" });
		await waitFor(() =>
			expect(play.className).toContain("music-player-attention"),
		);
		fireEvent.click(play);
		await screen.findByRole("button", { name: "一時停止" });
		expect(
			screen.getByRole("button", { name: "一時停止" }).className,
		).not.toContain("music-player-attention");
	});
});
