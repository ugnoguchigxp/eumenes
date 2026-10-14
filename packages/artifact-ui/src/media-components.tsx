import { useState } from "react";
import {
	MusicPlayer,
	MusicLibraryControls,
	Playlist,
	GenerationStatus,
	MusicWorkspace,
} from "@eumenes/design-system";
import type {
	ArtifactEvent,
	ArtifactRequest,
	MusicResource,
} from "./contracts";
import { isSafeImageUrl } from "./contracts";
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
	const { data, send, error, pending } = useMedia(request);
	if (data?.kind !== "music") return null;
	return (
		<div className="aui-stack">
			<Playlist
				title={request.title}
				tracks={data.tracks}
				currentTrackId={data.currentId}
				busy={pending || data.library?.loading}
				onFavorite={
					data.library
						? (id, favorite) => {
								void send("music-favorite", { id, favorite });
							}
						: undefined
				}
				onDelete={
					data.library
						? (id) => {
								void send("music-delete", { id });
							}
						: undefined
				}
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

export function MusicLibraryView({ request }: { request: ArtifactRequest }) {
	const { data, send, error } = useMedia(request);
	if (data?.kind !== "music" || !data.library) return null;
	const l = data.library;
	return (
		<MusicLibraryControls
			{...l}
			error={error || l.error}
			onSearch={(filter) => {
				void send("music-search", { filter: JSON.stringify(filter) });
			}}
			onMore={() => {
				void send("music-more");
			}}
			onRefresh={() => {
				void send("music-refresh");
			}}
		/>
	);
}

export function MusicWorkspaceView({ request }: { request: ArtifactRequest }) {
	const { data, send, error, pending } = useMedia(request);
	if (data?.kind !== "music") return null;
	if (!data.library && !data.creation && data.tracks.every((t) => t.disabled))
		return null;
	const tracks = data.tracks.map((t) => ({
		...t,
		artworkUrl:
			t.artworkUrl && isSafeImageUrl(t.artworkUrl) ? t.artworkUrl : undefined,
	}));
	const current = tracks.find((t) => t.id === data.currentId && !t.disabled);
	const library = data.library;
	return (
		<div className="aui-music-workspace">
			<MusicWorkspace
				tracks={tracks}
				currentTrackId={data.currentId}
				track={
					current?.url && isSafeAudioUrl(current.url)
						? { ...current, src: current.url }
						: null
				}
				title={request.title}
				downloadName={current?.downloadName}
				busy={pending || library?.loading}
				creation={
					data.creation
						? {
								options:
									request.view === "music-workspace"
										? request.creationOptions
										: undefined,
								busy: data.creation.busy,
								onGenerate: (prompt) => {
									void send("music-generate", { prompt });
								},
								status:
									data.creation.status && data.creation.title
										? {
												status: data.creation.status,
												title: data.creation.title,
												description: data.creation.description,
												cancelling: pending,
												onCancel: data.creation.canCancel
													? () => {
															void send("music-cancel");
														}
													: undefined,
											}
										: undefined,
							}
						: undefined
				}
				onSelect={(id) => {
					void send("music-select", { id });
				}}
				onArtwork={
					data.creation?.canArtwork
						? (id) => {
								void send("music-artwork", { id });
							}
						: undefined
				}
				onFavorite={
					library
						? (id, favorite) => {
								void send("music-favorite", { id, favorite });
							}
						: undefined
				}
				onDelete={
					library
						? (id) => {
								void send("music-delete", { id });
							}
						: undefined
				}
				controls={
					library && (
						<MusicLibraryControls
							{...library}
							compact
							error={error || library.error}
							onSearch={(filter) => {
								void send("music-search", { filter: JSON.stringify(filter) });
							}}
							onMore={() => {
								void send("music-more");
							}}
							onRefresh={() => {
								void send("music-refresh");
							}}
						/>
					)
				}
			/>
			{error && !library && <p role="alert">{error}</p>}
		</div>
	);
}
