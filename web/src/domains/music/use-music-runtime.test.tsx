import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import type {
	ArtifactEvent,
	MusicResource,
} from "@eumenes/artifact-ui/contracts";
import { musicStudioSource } from "./artifact-definition";
import { musicArtifactDefinition } from "./artifact-definition.fixture";
import { useMusicRuntime } from "./use-music-runtime";
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});
function setup(
	state = "completed",
	options: {
		studio?: boolean;
		empty?: boolean;
		other?: boolean;
		targetRef?: string;
		prompt?: string;
	} = {},
) {
	vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:audio");
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
	const items = options.empty
		? []
		: [
				{
					id: "a",
					runId: "original-run",
					state,
					title: "曲",
					description: "制作意図",
					prompt: options.prompt ?? null,
					artwork: undefined as
						| { state: string; revision: number; errorCode: null }
						| undefined,
					durationSeconds: 30,
					mime: "audio/ogg",
					createdAt: 1,
					updatedAt: 1,
				},
				...(options.other
					? [
							{
								id: "b",
								runId: "newer-run",
								state: "completed",
								title: "新しい曲",
								description: "",
								durationSeconds: 30,
								mime: "audio/ogg",
								createdAt: 2,
								updatedAt: 2,
							},
						]
					: []),
			];
	const run = { id: "new-run", status: "queued", revision: 1 };
	const api = {
		musicProviders: vi.fn(async () => ({ providers: [] })),
		musicList: vi.fn(async () => structuredClone(items)),
		musicAudio: vi.fn(async () => new Blob(["fixture"])),
		musicArtwork: vi.fn(async () => new Blob(["png"])),
		generateMusicArtwork: vi.fn(async (_id: string) => {
			items[0]!.artwork = { state: "completed", revision: 1, errorCode: null };
			items[0]!.updatedAt = 3;
			return items[0];
		}),
		submit: vi.fn(
			async (_input: {
				requestId: string;
				conversationId: string;
				text: string;
				presentation?: "conversation" | "artifact";
				toolchainId?: string;
			}) => ({ ...run }),
		),
		run: vi.fn(async () => ({ ...run })),
		cancel: vi.fn(async (_id: string) => {
			Object.assign(run, { status: "cancelled", revision: 2 });
			return { ...run };
		}),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const setTargetRef = vi.fn();
	const result = renderHook(
		() =>
			useMusicRuntime(
				api as never,
				"main",
				musicArtifactDefinition(options.studio ? undefined : "a"),
				options.targetRef,
				setTargetRef,
			),
		{
			wrapper: ({ children }: { children: ReactNode }) => (
				<QueryClientProvider client={cache}>{children}</QueryClientProvider>
			),
		},
	);
	const source = options.studio ? musicStudioSource : "music-a";
	const resource = () =>
		result.result.current.runtime.snapshot[source] as MusicResource;
	const event = (
		action: ArtifactEvent["action"],
		values: ArtifactEvent["values"] = {},
	): ArtifactEvent => ({
		id: crypto.randomUUID(),
		source,
		revision: resource().revision,
		action,
		values,
	});
	const dispatch = async (value: ArtifactEvent) => {
		let receipt;
		await act(async () => {
			receipt = await result.result.current.runtime.dispatch(value);
		});
		return receipt;
	};
	return { ...result, api, cache, setTargetRef, resource, event, dispatch };
}
test("a result link selects its saved track even when a newer track exists", async () => {
	const r = setup("completed", { studio: true, other: true, targetRef: "a" });
	await waitFor(() => expect(r.resource().currentId).toBe("a"));
	expect(r.result.current.targetMissing).toBe(false);
	expect(await r.dispatch(r.event("music-select", { id: "b" }))).toMatchObject({
		status: "accepted",
	});
	expect(r.setTargetRef).toHaveBeenCalledWith("b");
	const missing = setup("completed", {
		studio: true,
		other: true,
		targetRef: "deleted",
	});
	await waitFor(() => expect(missing.result.current.targetMissing).toBe(true));
	expect(missing.resource().currentId).toBe("");
});
test("authorized creation sends the exact editable prompt through the normal API and cancels the accepted run", async () => {
	const r = setup();
	await waitFor(() => expect(r.resource()).toBeTruthy());
	const prompt = "オーケストラ、柔らかい女性ボーカル。歌詞：[Verse]\n朝の光";
	expect(await r.dispatch(r.event("music-generate", { prompt }))).toMatchObject(
		{ status: "accepted" },
	);
	expect(r.api.submit).toHaveBeenCalledTimes(1);
	expect(r.api.submit.mock.calls[0]![0]).toMatchObject({
		conversationId: "main",
		text: expect.stringContaining(prompt),
		presentation: "artifact",
		toolchainId: "music.create",
	});
	await waitFor(() => expect(r.resource().creation?.canCancel).toBe(true));
	expect(r.resource().creation?.busy).toBe(true);
	expect(await r.dispatch(r.event("music-generate", { prompt }))).toMatchObject(
		{ status: "rejected" },
	);
	expect(await r.dispatch(r.event("music-cancel"))).toMatchObject({
		status: "accepted",
	});
	expect(r.api.cancel).toHaveBeenCalledWith("new-run");
	await waitFor(() => expect(r.resource().creation?.status).toBe("cancelled"));
});
test("the shared generation screen accepts the first creation with no previous music and keeps source validation", async () => {
	const r = setup("completed", { studio: true, empty: true });
	await waitFor(() => expect(r.result.current.loading).toBe(false));
	expect(r.resource().tracks).toEqual([]);
	expect(r.resource().creation?.busy).toBe(false);
	expect(r.api.musicAudio).not.toHaveBeenCalled();
	expect(
		await r.dispatch({
			...r.event("music-generate", { prompt: "静かな曲" }),
			source: "music-other",
		}),
	).toMatchObject({ status: "rejected" });
	expect(
		await r.dispatch(r.event("music-generate", { prompt: "静かな曲" })),
	).toMatchObject({ status: "accepted" });
	expect(r.api.submit).toHaveBeenCalledTimes(1);
	await waitFor(() => expect(r.resource().creation?.canCancel).toBe(true));
	expect(await r.dispatch(r.event("music-cancel"))).toMatchObject({
		status: "accepted",
	});
});
test("unknown source, stale revision, unsupported action and invalid prompt never create a run", async () => {
	const r = setup();
	await waitFor(() => expect(r.resource()).toBeTruthy());
	for (const value of [
		{ ...r.event("music-generate", { prompt: "曲" }), source: "music-other" },
		{ ...r.event("music-generate", { prompt: "曲" }), revision: -1 },
		r.event("music-delete", { id: "a" }),
		r.event("music-generate", { prompt: false }),
		r.event("music-generate", { prompt: " " }),
		r.event("music-generate", { prompt: "あ".repeat(7601) }),
	])
		expect(await r.dispatch(value)).not.toMatchObject({ status: "accepted" });
	expect(r.api.submit).not.toHaveBeenCalled();
});
test("an uncertain acknowledgement is retried only on user action with the same request ID", async () => {
	const r = setup();
	await waitFor(() => expect(r.resource()).toBeTruthy());
	r.api.submit.mockRejectedValueOnce(new Error("network lost"));
	expect(
		await r.dispatch(
			r.event("music-generate", { prompt: "暖かい男性声のジャズ" }),
		),
	).toMatchObject({ status: "rejected" });
	expect(r.api.submit).toHaveBeenCalledTimes(1);
	expect(
		await r.dispatch(
			r.event("music-generate", { prompt: "暖かい男性声のジャズ" }),
		),
	).toMatchObject({ status: "accepted" });
	expect(r.api.submit.mock.calls[0]![0].requestId).toBe(
		r.api.submit.mock.calls[1]![0].requestId,
	);
});
test("duplicate and simultaneous dispatches cannot create a second request", async () => {
	const r = setup();
	await waitFor(() => expect(r.resource()).toBeTruthy());
	let finish!: (value: {
		id: string;
		status: string;
		revision: number;
	}) => void;
	r.api.submit.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const event = r.event("music-generate", { prompt: "明るい曲" });
	let first!: Promise<unknown>;
	act(() => {
		first = r.result.current.runtime.dispatch(event);
	});
	expect(await r.dispatch(event)).toMatchObject({ status: "duplicate" });
	expect(
		await r.dispatch(r.event("music-generate", { prompt: "別の曲" })),
	).toMatchObject({ status: "rejected" });
	await act(async () => {
		finish({ id: "new-run", status: "queued", revision: 1 });
		await first;
	});
	expect(r.api.submit).toHaveBeenCalledTimes(1);
});
test("artwork is requested for the selected completed track and its image is shown by the host", async () => {
	const r = setup("completed", { prompt: "雨の夜のピアノ" });
	await waitFor(() => expect(r.resource().canArtwork).toBe(true));
	expect(r.resource().tracks[0]!.artworkUrl).toBeUndefined();
	expect(
		await r.dispatch(r.event("music-artwork", { id: "missing" })),
	).toMatchObject({ status: "rejected" });
	expect(await r.dispatch(r.event("music-artwork", { id: "a" }))).toMatchObject(
		{ status: "accepted" },
	);
	expect(r.api.generateMusicArtwork).toHaveBeenCalledWith("a");
	await waitFor(() =>
		expect(r.resource().tracks[0]).toMatchObject({
			artworkStatus: "completed",
			artworkUrl: "blob:audio",
		}),
	);
	expect(r.api.musicArtwork).toHaveBeenCalledWith("a", expect.anything());
	const none = setup("completed");
	await waitFor(() => expect(none.resource()).toBeTruthy());
	expect(
		await none.dispatch(none.event("music-artwork", { id: "a" })),
	).toMatchObject({ status: "rejected" });
});

test("structured SFX selections survive submission and mixed lyrics are rejected", async () => {
	const r = setup("completed", { studio: true, empty: true });
	await waitFor(() => expect(r.result.current.loading).toBe(false));
	const invalid = {
		task: "sound-effect",
		lyrics: "hidden words",
		durationSeconds: 1.5,
	};
	expect(
		await r.dispatch(
			r.event("music-generate", {
				prompt: "chime",
				generation: JSON.stringify(invalid),
			}),
		),
	).toMatchObject({ status: "rejected" });
	expect(r.api.submit).not.toHaveBeenCalled();
	const input = { task: "sound-effect", durationSeconds: 1.5 };
	expect(
		await r.dispatch(
			r.event("music-generate", {
				prompt: "chime",
				generation: JSON.stringify(input),
			}),
		),
	).toMatchObject({ status: "accepted" });
	expect(r.api.submit.mock.calls[0]![0].text).toContain(JSON.stringify(input));
	expect(r.api.submit.mock.calls[0]![0].text).not.toContain("hidden words");
});
