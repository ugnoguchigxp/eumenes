import { useQueryClient } from "@tanstack/react-query";
import { requestPlayback } from "@eumenes/design-system";
import { useEffect, useRef } from "react";
import { formatResourceUri } from "../../../../api/domains/resources/contracts";
import { queryRoots } from "../../queryKeys";
import {
	createLiveScreen,
	type WebArtifactAdapter,
} from "../toolchain-artifacts/registry";
import { useMusicRuntime } from "./use-music-runtime";

export const MUSIC_SCREEN_ADAPTER_REF = "adapter:music-screen@1";

/** What the mounted music screen shows, read through the latest render. */
type MusicScreen = {
	/** Tracks that can be played (completed). */
	playable: ReadonlySet<string>;
	currentId: string | undefined;
	visible: boolean;
	show(trackId: string): void;
};
const live = createLiveScreen<{ read(): MusicScreen }>();

/** Selects the track on the open screen; false when it is not a playable track of the screen. */
async function showTrack(trackId: string) {
	const known = await live.waitFor((handle) =>
		handle.read().playable.has(trackId),
	);
	if (!known) return false;
	if (live.current()?.read().currentId !== trackId)
		live.current()?.read().show(trackId);
	return !!(await live.waitFor(
		(handle) => handle.read().currentId === trackId,
	));
}

/** The registered view uses the existing authenticated creation, cancellation and audio APIs. */
export const musicScreenWebAdapter: WebArtifactAdapter = {
	adapterRef: MUSIC_SCREEN_ADAPTER_REF,
	useArtifact({ client, artifact, targetRef, setTargetRef, visible }) {
		const cache = useQueryClient();
		const definition = JSON.stringify(
			artifact.variants.find((v) => v.id === artifact.defaultVariant)
				?.definition,
		);
		const { runtime, loading, error, targetMissing } = useMusicRuntime(
			client,
			"main",
			definition,
			targetRef,
			setTargetRef,
		);
		const music = Object.values(runtime.snapshot).find(
			(resource) => resource.kind === "music",
		);
		const screen: MusicScreen = {
			playable: new Set(
				music?.tracks.filter((t) => !t.disabled).map((t) => t.id),
			),
			currentId: music?.currentId || undefined,
			visible,
			show: (trackId) => setTargetRef(trackId),
		};
		const latest = useRef(screen);
		useEffect(() => {
			latest.current = screen;
		});
		useEffect(() => live.attach({ read: () => latest.current }), []);
		return {
			phase: error
				? { kind: "error", message: "楽曲の情報を取得できませんでした。" }
				: loading
					? { kind: "loading" }
					: targetMissing
						? { kind: "blocked", message: "指定された楽曲は見つかりません。" }
						: { kind: "ready" },
			snapshot: runtime.snapshot,
			targetOf: () => undefined,
			local: (_binding, event) => runtime.dispatch(event),
			settled: () => {},
			refresh: () => {
				void cache.invalidateQueries({ queryKey: [queryRoots.music] });
			},
		};
	},
	focus: showTrack,
	async play(trackId) {
		if (!(await showTrack(trackId))) throw new Error("track_unavailable");
		await requestPlayback(trackId);
	},
	viewing() {
		const screen = live.current()?.read();
		return screen?.visible && screen.currentId
			? formatResourceUri("music.track", screen.currentId)
			: null;
	},
};
