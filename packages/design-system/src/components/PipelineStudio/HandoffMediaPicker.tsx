import { useState } from "react";
import { Button } from "../Button";
import { ImagePicker } from "../ImagePicker";
import { Playlist } from "../Playlist";
import { MusicPlayer } from "../MusicPlayer";
import type { PipelineMaterial, PipelineMediaLibrary } from "./handoff-types";
import type { PipelineHandoffProps } from "./PipelineHandoff";

export function HandoffMediaPicker({
	kind,
	library,
	query,
	setQuery,
	onLibrary,
	onSelect,
	onBack,
}: {
	kind: "image" | "music";
	library?: PipelineMediaLibrary;
	query: string;
	setQuery: (query: string) => void;
	onLibrary: PipelineHandoffProps["onLibrary"];
	onSelect: (material: PipelineMaterial) => void;
	onBack: () => void;
}) {
	const [selectedTrack, setSelectedTrack] = useState<string>();
	if (kind === "image")
		return (
			<section className="pipeline-handoff-picker">
				{library?.kind === "image" ? (
					<ImagePicker
						savedOnly
						images={library.images}
						loading={library.loading}
						error={library.error}
						onRefresh={() => onLibrary("image")}
						onConfirm={(id) => {
							const image = library.images.find((item) => item.id === id);
							if (image) {
								onSelect({ kind: "image", id, title: image.title });
								onBack();
							}
						}}
						onCancel={onBack}
					/>
				) : (
					<>
						<Button onClick={onBack}>戻る</Button>
						<p>読み込んでいます。</p>
					</>
				)}
			</section>
		);
	if (kind === "music") {
		const media = library?.kind === "music" ? library : undefined;
		const track = media?.tracks.find((item) => item.id === selectedTrack);
		return (
			<section className="pipeline-handoff-picker" aria-label="楽曲を選ぶ">
				<header>
					<Button size="sm" variant="outline" onClick={onBack}>
						戻る
					</Button>
					<h3>楽曲を選ぶ</h3>
				</header>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						onLibrary("music", query);
					}}
				>
					<label>
						曲名・内容
						<input
							value={query}
							maxLength={500}
							onChange={(event) => setQuery(event.target.value)}
						/>
					</label>
					<Button size="sm" type="submit">
						検索
					</Button>
				</form>
				{media?.error && (
					<div role="alert">
						{media.error}
						<Button size="sm" onClick={() => onLibrary("music", query)}>
							再試行
						</Button>
					</div>
				)}
				{media?.loading && <output>読み込んでいます。</output>}
				<Playlist
					compact
					title="保存した楽曲"
					tracks={media?.tracks ?? []}
					currentTrackId={selectedTrack}
					onSelect={setSelectedTrack}
				/>
				{track && (
					<MusicPlayer
						key={track.id}
						compact
						track={{ ...track, src: track.audioUrl }}
					/>
				)}
				{media?.hasMore && (
					<Button
						size="sm"
						variant="outline"
						disabled={media.loading}
						onClick={() => onLibrary("music", media.query, true)}
					>
						さらに表示
					</Button>
				)}
				<footer>
					<Button size="sm" variant="outline" onClick={onBack}>
						キャンセル
					</Button>
					<Button
						size="sm"
						disabled={!track || !!media?.error || !!media?.loading}
						onClick={() => {
							if (track) {
								onSelect({ kind: "music", id: track.id, title: track.title });
								onBack();
							}
						}}
					>
						この楽曲を使う
					</Button>
				</footer>
			</section>
		);
	}
	return null;
}
