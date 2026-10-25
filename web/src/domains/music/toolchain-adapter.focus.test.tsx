import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { requestPlayback } from "@eumenes/design-system";
import { useState, type ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { musicScreenWebAdapter } from "./toolchain-adapter";

vi.mock("@eumenes/design-system", async (importOriginal) => ({
	...(await importOriginal<typeof import("@eumenes/design-system")>()),
	requestPlayback: vi.fn(async () => {}),
}));

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.mocked(requestPlayback).mockReset();
	vi.mocked(requestPlayback).mockResolvedValue(undefined);
});

const track = (id: string, state: string, createdAt: number) => ({
	id,
	runId: `run-${id}`,
	state,
	title: `曲 ${id}`,
	description: "",
	prompt: null,
	durationSeconds: 30,
	mime: "audio/ogg",
	createdAt,
	updatedAt: createdAt,
});

function mount(visible = true) {
	vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:audio");
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
	const client = {
		identity: crypto.randomUUID(),
		musicProviders: vi.fn(async () => ({ providers: [] })),
		musicList: vi.fn(async () => [
			track("a", "completed", 1),
			track("b", "completed", 2),
			track("c", "generating", 0),
		]),
		musicAudio: vi.fn(async () => new Blob(["fixture"])),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const artifact = {
		defaultVariant: "standard",
		variants: [
			{
				id: "standard",
				definition: { view: "music-workspace", source: "music-studio" },
			},
		],
	};
	return renderHook(
		() => {
			// The host keeps the tab's target; the screen asks it to change.
			const [targetRef, setTargetRef] = useState<string | undefined>();
			return musicScreenWebAdapter.useArtifact({
				client: client as never,
				artifact: artifact as never,
				targetRef,
				setTargetRef,
				visible,
			} as never);
		},
		{
			wrapper: ({ children }: { children: ReactNode }) => (
				<QueryClientProvider client={cache}>{children}</QueryClientProvider>
			),
		},
	);
}

const ready = (view: ReturnType<typeof mount>) =>
	waitFor(() => expect(view.result.current.phase.kind).toBe("ready"));

test("viewing is the URI of the track the screen has selected, and null while hidden", async () => {
	const shown = mount();
	await ready(shown);
	await waitFor(() =>
		expect(musicScreenWebAdapter.viewing?.()).toBe("eumenes://music.track/b"),
	);
	shown.unmount();
	expect(musicScreenWebAdapter.viewing?.()).toBeNull();
	const hidden = mount(false);
	await ready(hidden);
	expect(musicScreenWebAdapter.viewing?.()).toBeNull();
});

test("focus selects the track on the screen", async () => {
	const view = mount();
	await ready(view);
	// The screen applies the selection on its own render: not inside one `act`.
	const focused = musicScreenWebAdapter.focus?.("a");
	await waitFor(() =>
		expect(musicScreenWebAdapter.viewing?.()).toBe("eumenes://music.track/a"),
	);
	await expect(focused).resolves.toBe(true);
	expect(requestPlayback).not.toHaveBeenCalled();
});

test("a track that is still being made cannot be focused", async () => {
	const view = mount();
	await ready(view);
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const focused = musicScreenWebAdapter.focus?.("c");
	await vi.advanceTimersByTimeAsync(5_500);
	await expect(focused).resolves.toBe(false);
});

test("play selects the track, then starts its player", async () => {
	const view = mount();
	await ready(view);
	await musicScreenWebAdapter.play?.("a");
	expect(requestPlayback).toHaveBeenCalledWith("a");
	expect(musicScreenWebAdapter.viewing?.()).toBe("eumenes://music.track/a");
});

test("a browser refusal reaches the caller as the player's own error", async () => {
	const view = mount();
	await ready(view);
	vi.mocked(requestPlayback).mockRejectedValueOnce(
		new DOMException("blocked", "NotAllowedError"),
	);
	await expect(musicScreenWebAdapter.play?.("b")).rejects.toMatchObject({
		name: "NotAllowedError",
	});
});
