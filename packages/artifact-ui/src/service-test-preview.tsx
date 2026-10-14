import { useEffect, useState } from "react";
import type { CollectionRow } from "./collection-contracts";
import { useArtifactRuntime } from "./runtime";

export function ServiceTestPreview({ row }: { row: CollectionRow }) {
	const runtime = useArtifactRuntime();
	const media = row.media?.preview;
	const path = media?.path;
	const fetchMedia = runtime.fetchMedia;
	const [url, setUrl] = useState<string>();
	const [error, setError] = useState("");
	useEffect(() => {
		if (!path || !fetchMedia) return;
		let current = true;
		let objectUrl: string | undefined;
		void fetchMedia(path)
			.then((blob) => {
				if (!current) return;
				objectUrl = URL.createObjectURL(blob);
				setUrl(objectUrl);
			})
			.catch(() => {
				if (current) setError("結果の読み込みに失敗しました。");
			});
		return () => {
			current = false;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [path, fetchMedia]);
	if (!media) return null;
	return (
		<div className="aui-service-preview">
			{error && <p role="alert">{error}</p>}
			{url &&
				(media.mime.startsWith("image/") ? (
					<a href={url} target="_blank" rel="noreferrer">
						<img src={url} alt="生成した画像" />
					</a>
				) : (
					<audio src={url} controls preload="metadata">
						<track
							kind="captions"
							srcLang="ja"
							label="結果の文字起こし"
							src={`data:text/vtt,${encodeURIComponent(`WEBVTT\n\n00:00:00.000 --> 00:10:00.000\n${row.cells.text ?? ""}`)}`}
						/>
					</audio>
				))}
			{url && (
				<a
					href={url}
					download={`eumenes-${row.id}.${media.mime === "image/png" ? "png" : media.mime === "image/webp" ? "webp" : media.mime === "audio/mpeg" ? "mp3" : "wav"}`}
				>
					結果を保存
				</a>
			)}
		</div>
	);
}
