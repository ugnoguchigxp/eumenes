import { useEffect, useRef, useState } from "react";
import { Film, Grid2X2, Play } from "lucide-react";
import { Button } from "../Button";
import { GenerationStatus } from "../GenerationStatus";
import {
	VideoCreationForm,
	type VideoDraft,
	type VideoSettings,
} from "./VideoCreationForm";
import "./VideoWorkspace.css";

export type { VideoDraft } from "./VideoCreationForm";
type VideoCard = {
	id: string;
	title: string;
	label: string;
	previewSrc?: string;
};
type SelectedVideo = {
	id: string;
	title: string;
	label: string;
	loading: boolean;
	url?: string;
	error?: string;
	details?: readonly { label: string; value: string }[];
};
export type VideoWorkspaceProps = {
	title?: string;
	model?: string;
	options?: VideoSettings;
	canGenerate: boolean;
	pending: boolean;
	admission?: string;
	error?: string;
	job?: {
		title: string;
		status: "queued" | "running" | "completed" | "failed" | "cancelled";
		message?: string;
		cancellable: boolean;
		reconcilable: boolean;
	};
	retrySubmission?: boolean;
	videos: readonly VideoCard[];
	loading: boolean;
	selected?: SelectedVideo;
	onGenerate(input: VideoDraft): void;
	onRetry(): void;
	onCancel(): void;
	onSelect(id: string): void;
	onDelete(id: string): void;
	onRefresh(): void;
};

/** A paused first frame, loaded only when its card approaches the visible area. */
function VideoThumbnail({ src }: { src?: string }) {
	const ref = useRef<HTMLSpanElement>(null);
	const [nearby, setNearby] = useState(false);
	useEffect(() => {
		if (!src || !ref.current || nearby) return;
		if (typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry?.isIntersecting) {
					setNearby(true);
					observer.disconnect();
				}
			},
			{ rootMargin: "100px" },
		);
		observer.observe(ref.current);
		return () => observer.disconnect();
	}, [src, nearby]);
	return (
		<span className="ds-video-thumbnail" ref={ref} aria-hidden="true">
			<Film />
			{src && nearby && (
				// A decorative still. The selected video player is a separate control.
				// eslint-disable-next-line jsx-a11y/media-has-caption
				<video muted playsInline preload="auto" src={src} tabIndex={-1} />
			)}
			<Play className="ds-video-thumbnail-play" />
		</span>
	);
}

function VideoPreview({
	video,
	gallery,
	pending,
	onDelete,
}: {
	video: SelectedVideo;
	gallery: boolean;
	pending: boolean;
	onDelete(id: string): void;
}) {
	const [confirm, setConfirm] = useState(false);
	const player = useRef<HTMLVideoElement>(null);
	const [playError, setPlayError] = useState(false);
	return (
		<section className="ds-video-card ds-video-preview" aria-label="プレビュー">
			<h3>プレビュー</h3>
			<div className="ds-video-preview-body">
				{video.url && (
					// LARM provides video and audio without caption data.
					// eslint-disable-next-line jsx-a11y/media-has-caption
					<video
						ref={player}
						controls
						playsInline
						preload="metadata"
						src={video.url}
						aria-label={video.title}
					/>
				)}
				<div>
					<strong>{video.title}</strong>
					<p className="ds-video-spec">{video.label}</p>
					{video.loading && <output>動画を取得しています。</output>}
					{(video.error || playError) && (
						<p role="alert">{video.error ?? "動画を再生できませんでした。"}</p>
					)}
					<div className="ds-video-actions">
						{video.url && (
							<>
								{!gallery && (
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => {
											void player.current
												?.play()
												.catch(() => setPlayError(true));
										}}
									>
										再生
									</Button>
								)}
								<Button asChild variant="outline" size="sm">
									<a href={video.url} download={`${video.title}.mp4`}>
										MP4を保存
									</a>
								</Button>
							</>
						)}
						{gallery && (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								disabled={pending}
								onClick={() => setConfirm(true)}
							>
								削除
							</Button>
						)}
					</div>
				</div>
			</div>
			{gallery && confirm && (
				<div className="ds-video-actions">
					<span>「{video.title}」を削除しますか？</span>
					<Button
						type="button"
						variant="destructive"
						disabled={pending}
						onClick={() => {
							onDelete(video.id);
							setConfirm(false);
						}}
					>
						削除する
					</Button>
					<Button
						type="button"
						variant="secondary"
						onClick={() => setConfirm(false)}
					>
						戻る
					</Button>
				</div>
			)}
			{gallery && !!video.details?.length && (
				<details>
					<summary>生成条件とファイル情報</summary>
					<dl>
						{video.details.map(({ label, value }) => (
							<div key={label}>
								<dt>{label}</dt>
								<dd>{value}</dd>
							</div>
						))}
					</dl>
				</details>
			)}
		</section>
	);
}

export function VideoWorkspace(props: VideoWorkspaceProps) {
	const [gallery, setGallery] = useState(false);
	const body = useRef<HTMLDivElement>(null);
	const { job, selected } = props;
	const title = props.title ?? "動画生成";
	return (
		<section className="ds-video-workspace" aria-label="動画生成">
			<header className="ds-video-header">
				<h2>{gallery ? "動画一覧" : title}</h2>
				<Button
					type="button"
					size="sm"
					variant="outline"
					onClick={() => {
						setGallery(!gallery);
						body.current?.scrollTo(0, 0);
					}}
				>
					{gallery ? (
						<Film aria-hidden="true" />
					) : (
						<Grid2X2 aria-hidden="true" />
					)}
					{gallery ? "動画生成" : "動画一覧"}
				</Button>
			</header>
			<div className="ds-video-body" ref={body}>
				{props.admission && (
					<output className="ds-video-admission">{props.admission}</output>
				)}
				{props.error && (
					<p className="ds-video-error" role="alert">
						{props.error}
					</p>
				)}
				{job && (
					<div className="ds-video-card ds-video-job">
						<GenerationStatus
							status={job.status === "queued" ? "pending" : job.status}
							title={job.title}
							description={job.message}
							onCancel={job.cancellable ? props.onCancel : undefined}
							cancelling={props.pending}
						/>
					</div>
				)}
				{(job?.reconcilable || props.retrySubmission) && (
					<Button
						type="button"
						variant="secondary"
						disabled={props.pending}
						onClick={props.onRetry}
					>
						同じ依頼の受付・状態を確認
					</Button>
				)}
				{gallery && (
					<section className="ds-video-library" aria-label="保存済み動画">
						<header className="ds-video-heading">
							<h3>保存済み動画</h3>
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={props.pending}
								onClick={props.onRefresh}
							>
								更新
							</Button>
						</header>
						{props.loading ? (
							<output>一覧を取得しています。</output>
						) : (
							props.videos.length === 0 && <p>保存済みの動画はありません。</p>
						)}
						<ul className="ds-video-list">
							{props.videos.map((item) => (
								<li key={item.id}>
									<button
										type="button"
										aria-pressed={selected?.id === item.id}
										onClick={() => props.onSelect(item.id)}
									>
										<VideoThumbnail src={item.previewSrc} />
										<span className="ds-video-list-label">
											<strong>{item.title}</strong>
											<small>{item.label}</small>
										</span>
									</button>
								</li>
							))}
						</ul>
					</section>
				)}
				{selected ? (
					<VideoPreview
						key={`${selected.id}:${gallery}`}
						video={selected}
						gallery={gallery}
						pending={props.pending}
						onDelete={props.onDelete}
					/>
				) : (
					!gallery && (
						<section className="ds-video-card ds-video-preview-empty">
							<h3>プレビュー</h3>
							<p>完成した動画をここで再生できます。</p>
						</section>
					)
				)}
				<div hidden={gallery}>
					<VideoCreationForm
						options={props.options}
						canGenerate={props.canGenerate && !gallery}
						pending={props.pending}
						model={props.model}
						onGenerate={props.onGenerate}
					/>
				</div>
			</div>
		</section>
	);
}
