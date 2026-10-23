import { ImageOff, Loader2 } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { Button } from "../Button";
import { Modal } from "../Modal";
import {
	MusicPlayer,
	type MusicPlaybackState,
	type MusicTrack,
	type PlaylistTrack,
} from "../MusicPlayer";
import { Playlist } from "../Playlist";
import { MusicCurrentTrack } from "./MusicCurrentTrack";
import { MusicVisualizer } from "./MusicVisualizer";
import { MusicTrackDetails } from "./MusicTrackDetails";
import { MusicCreationPanel } from "./MusicCreationPanel";
import type {
	MusicCreationOptions,
	MusicCreationInput,
	MusicDurationModel,
} from "./music-creation-options";
import type { GenerationStatusProps } from "../GenerationStatus";
import "./MusicWorkspace.css";

export type MusicWorkspaceProps = {
	tracks: readonly PlaylistTrack[];
	currentTrackId?: string;
	track: MusicTrack | null;
	title?: string;
	controls?: ReactNode;
	busy?: boolean;
	onSelect: (id: string) => void;
	onFavorite?: (id: string, favorite: boolean) => void;
	onDelete?: (id: string) => void;
	downloadName?: string;
	/** Starts (or restarts) artwork generation for a track; omitted when the host cannot generate. */
	onArtwork?: (id: string) => void;
	creation?: {
		busy?: boolean;
		status?: GenerationStatusProps;
		options?: MusicCreationOptions;
		models?: readonly MusicDurationModel[];
		onGenerate: (prompt: string, input?: MusicCreationInput) => void;
	};
};

function useTrackDetails() {
	const [detailId, setDetailId] = useState<string>();
	const detailTrigger = useRef<HTMLElement | null>(null);
	const openDetail = (id: string) => {
		detailTrigger.current =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		setDetailId(id);
	};
	return { detailId, setDetailId, detailTrigger, openDetail };
}

export function MusicWorkspace({
	tracks,
	currentTrackId,
	track,
	title = "プレイリスト",
	controls,
	busy,
	onSelect,
	onFavorite,
	onDelete,
	downloadName,
	onArtwork,
	creation,
}: MusicWorkspaceProps) {
	const [display, setDisplay] = useState<"visualizer" | "image">("visualizer");
	const [tab, setTab] = useState<"create" | "history">("create");
	const [draft, setDraft] = useState<{ prompt: string; revision: number }>();
	const [mode, setMode] = useState<"spectrum" | "waveform">("spectrum");
	const [playback, setPlayback] = useState<MusicPlaybackState | null>(null);
	const { detailId, setDetailId, detailTrigger, openDetail } =
		useTrackDetails();
	const [page, setPage] = useState(0);
	const [failedImage, setFailedImage] = useState<string>();
	const current = tracks.find((t) => t.id === currentTrackId);
	const detail = tracks.find((t) => t.id === detailId);
	const activePlayback = playback?.id === current?.id ? playback : null;
	const available = tracks.filter((t) => !t.disabled);
	const index = available.findIndex((t) => t.id === currentTrackId);
	const pages = Math.max(1, Math.ceil(tracks.length / 8));
	const currentPage = Math.min(page, pages - 1);
	const shown = tracks.slice(currentPage * 8, (currentPage + 1) * 8);
	const neighbor = (offset: number) => available[index + offset];
	const next =
		index >= 0 && neighbor(1) ? () => onSelect(neighbor(1)!.id) : undefined;
	const image = current?.artworkUrl;
	// Show progress from the click until the host reports the generation (or rejects it).
	const [artworkRequest, setArtworkRequest] = useState<string>();
	const artworkStatus =
		current?.artworkStatus === "generating" ||
		(busy && current && artworkRequest === current.id)
			? "generating"
			: current?.artworkStatus;
	return (
		<section
			className={`music-workspace${creation ? " music-workspace-creation" : ""}`}
			aria-label="音楽ワークスペース"
		>
			<div className="music-workspace-body">
				<section className="music-workspace-visual" aria-label="楽曲の表示">
					<div className="music-workspace-visual-toolbar">
						<div
							className="music-workspace-display"
							role="group"
							aria-label="左側の表示"
						>
							<Button
								size="sm"
								variant={display === "visualizer" ? "secondary" : "ghost"}
								aria-pressed={display === "visualizer"}
								onClick={() => setDisplay("visualizer")}
							>
								Visualizer
							</Button>
							<Button
								size="sm"
								variant={display === "image" ? "secondary" : "ghost"}
								aria-pressed={display === "image"}
								onClick={() => setDisplay("image")}
							>
								楽曲イメージ
							</Button>
						</div>
						{display === "visualizer" && (
							<select
								aria-label="Visualizerの表示"
								value={mode}
								onChange={(e) => setMode(e.target.value as typeof mode)}
							>
								<option value="spectrum">スペクトラム</option>
								<option value="waveform">波形</option>
							</select>
						)}
					</div>
					<div className="music-workspace-stage">
						<div
							hidden={display !== "visualizer"}
							className="music-workspace-visualizer"
						>
							<MusicVisualizer
								analyser={activePlayback?.analyser ?? null}
								playing={activePlayback?.playing ?? false}
								active={display === "visualizer"}
								mode={mode}
							/>
							{!activePlayback?.analyser && (
								<p>
									{activePlayback?.analysisError
										? "この環境ではVisualizerを利用できません。音声の再生は続けられます。"
										: "再生すると音に合わせて表示します。"}
								</p>
							)}
						</div>
						{display === "image" && (
							<figure className="music-workspace-artwork">
								{image &&
								failedImage !== image &&
								artworkStatus !== "generating" ? (
									<img
										src={image}
										alt={`${current.title}の楽曲イメージ`}
										onError={() => setFailedImage(image)}
									/>
								) : (
									<div className="music-workspace-no-image">
										{artworkStatus === "generating" ? (
											<Loader2
												aria-hidden="true"
												className="music-workspace-spin"
											/>
										) : (
											<ImageOff aria-hidden="true" />
										)}
										<p role={artworkStatus === "failed" ? "alert" : undefined}>
											{artworkStatus === "generating"
												? "楽曲イメージを生成しています。"
												: artworkStatus === "failed"
													? "楽曲イメージを作成できませんでした。"
													: image
														? "楽曲イメージを読み込めませんでした。"
														: "この楽曲のイメージは未登録です。"}
										</p>
									</div>
								)}
								{current && <figcaption>{current.title}</figcaption>}
							</figure>
						)}
					</div>
					{onArtwork && current && !current.disabled && display === "image" && (
						<div className="music-workspace-artwork-actions">
							<span>
								{current.prompt
									? "この曲のプロンプトから256×256で作成します"
									: "プロンプトがないため作成できません"}
							</span>
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={
									busy || artworkStatus === "generating" || !current.prompt
								}
								onClick={() => {
									setArtworkRequest(current.id);
									onArtwork(current.id);
								}}
							>
								{artworkStatus === "generating" ? (
									<>
										<Loader2
											aria-hidden="true"
											className="music-workspace-spin"
										/>
										生成中
									</>
								) : image ? (
									"作り直す"
								) : (
									"イメージを作成"
								)}
							</Button>
						</div>
					)}
					<MusicCurrentTrack
						current={current}
						activePlayback={activePlayback}
						busy={busy}
						onFavorite={onFavorite}
						openDetail={openDetail}
					/>
				</section>
				<section className="music-workspace-library" aria-label="楽曲一覧">
					{creation && (
						<MusicCreationPanel
							creation={creation}
							busy={busy}
							draft={draft}
							tab={tab}
							onTab={setTab}
						/>
					)}
					<div
						hidden={!!creation && tab !== "history"}
						className="music-workspace-history"
					>
						{controls}
						{creation && current?.prompt && (
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={() => {
									setDraft({
										prompt: current.prompt!,
										revision: (draft?.revision ?? 0) + 1,
									});
									setTab("create");
								}}
							>
								この曲のプロンプトを使う
							</Button>
						)}
						<div className="music-workspace-list-heading">
							<span>曲名</span>
							<span>長さ</span>
							<span />
						</div>
						<Playlist
							compact
							title={title}
							tracks={shown}
							currentTrackId={currentTrackId}
							busy={busy}
							onSelect={onSelect}
							onDetail={openDetail}
						/>
						{pages > 1 && (
							<nav
								className="music-workspace-pagination"
								aria-label="楽曲一覧のページ"
							>
								<Button
									size="sm"
									variant="ghost"
									disabled={currentPage === 0}
									onClick={() => setPage(currentPage - 1)}
								>
									前へ
								</Button>
								<span>
									{currentPage + 1} / {pages}
								</span>
								<Button
									size="sm"
									variant="ghost"
									disabled={currentPage + 1 === pages}
									onClick={() => setPage(currentPage + 1)}
								>
									次へ
								</Button>
							</nav>
						)}
					</div>
				</section>
			</div>
			<MusicPlayer
				compact
				track={track}
				loading={!!current && !current.disabled && !track}
				onPlaybackChange={setPlayback}
				onPrevious={index > 0 ? () => onSelect(neighbor(-1)!.id) : undefined}
				onNext={next}
				onEnded={next}
			/>
			<Modal
				open={!!detail}
				onOpenChange={(open) => {
					if (!open) setDetailId(undefined);
				}}
				title="楽曲の詳細"
				description="曲の説明と情報を確認できます。"
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					detailTrigger.current?.focus();
				}}
			>
				{detail && (
					<MusicTrackDetails
						key={detail.id}
						track={detail}
						busy={busy}
						onDelete={onDelete}
						download={
							track?.id === detail.id
								? { url: track.src, name: downloadName }
								: undefined
						}
					/>
				)}
			</Modal>
		</section>
	);
}
