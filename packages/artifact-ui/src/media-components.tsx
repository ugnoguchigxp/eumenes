import { useState } from "react";
import {
	MusicPlayer,
	Playlist,
	GenerationStatus,
} from "@eumenes/design-system";
import type {
	ArtifactEvent,
	ArtifactRequest,
	MusicResource,
} from "./contracts";
import { isSafeAudioUrl } from "./media-contracts";
import { useArtifactRuntime } from "./runtime";

function useMedia(request: ArtifactRequest) {
	const runtime = useArtifactRuntime();
	const source = request.source!;
	const data = runtime.snapshot[source];
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const send = async (
		action: ArtifactEvent["action"],
		values: ArtifactEvent["values"] = {},
	) => {
		if (pending || !data) return;
		setPending(true);
		try {
			const receipt = await runtime.dispatch({
				id: crypto.randomUUID(),
				source,
				revision: data.revision,
				action,
				values,
			});
			setError(
				receipt.status === "rejected" || receipt.status === "conflict"
					? receipt.message
					: "",
			);
		} catch {
			setError("操作を実行できませんでした。");
		} finally {
			setPending(false);
		}
	};
	return { data, send, pending, error };
}
export function MusicView({ request }: { request: ArtifactRequest }) {
	const { data, send, error } = useMedia(request);
	if (data?.kind !== "music") return null;
	const tracks = data.tracks.filter((t) => !t.disabled);
	const index = tracks.findIndex((t) => t.id === data.currentId);
	const track = tracks[index];
	if (!track?.url || !isSafeAudioUrl(track.url)) return null;
	const select = (t: MusicResource["tracks"][number] | undefined) =>
		t
			? () => {
					void send("music-select", { id: t.id });
				}
			: undefined;
	return (
		<div className="aui-stack">
			<MusicPlayer
				track={{ ...track, src: track.url }}
				onPrevious={select(tracks[index - 1])}
				onNext={select(tracks[index + 1])}
			/>
			<a href={track.url} download={track.downloadName ?? "music"}>
				楽曲を保存
			</a>
			{error && <p role="alert">{error}</p>}
		</div>
	);
}
export function PlaylistView({ request }: { request: ArtifactRequest }) {
	const { data, send, error } = useMedia(request);
	if (data?.kind !== "music") return null;
	return (
		<div className="aui-stack">
			<Playlist
				title={request.title}
				tracks={data.tracks}
				currentTrackId={data.currentId}
				onSelect={(id) => {
					void send("music-select", { id });
				}}
			/>
			{error && <p role="alert">{error}</p>}
		</div>
	);
}
export function GenerationView({ request }: { request: ArtifactRequest }) {
	const { data, send, pending, error } = useMedia(request);
	if (data?.kind !== "generation" || data.hidden) return null;
	return (
		<div className="aui-stack">
			<GenerationStatus
				status={data.status}
				title={request.title ?? data.title}
				description={data.description}
				progress={data.progress}
				cancelling={pending}
				onCancel={
					data.canCancel
						? () => {
								void send("generation-cancel");
							}
						: undefined
				}
				onRetry={
					data.canRetry
						? () => {
								void send("generation-retry");
							}
						: undefined
				}
			/>
			{error && <p role="alert">{error}</p>}
		</div>
	);
}
