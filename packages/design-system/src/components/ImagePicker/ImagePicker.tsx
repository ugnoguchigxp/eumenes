import { useEffect, useRef, useState, type ReactNode } from "react";
import { Download, Trash2 } from "lucide-react";
import { Button } from "../Button";
import { ImageFrame } from "../ImageViewer/ImageFrame";
import { Modal } from "../Modal";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../Tabs";
import { ImageGrid, type ImageGridItem } from "./ImageGrid";

export type ImagePickerProps = {
	images: readonly ImageGridItem[];
	/** Only browse saved images; omit upload and external providers. */
	savedOnly?: boolean;
	selectedId?: string;
	loading?: boolean;
	error?: string;
	pending?: boolean;
	onRefresh?: () => void;
	onConfirm: (id: string) => void;
	onCancel: () => void;
	onDelete?: (id: string) => Promise<boolean>;
	renderGooglePhotos?: (onSelect: (image: ImageGridItem) => void) => ReactNode;
	onUpload?: (
		file: File,
		requestId: string,
		signal: AbortSignal,
	) => Promise<ImagePickerUploadResult>;
};
export type ImagePickerUploadResult =
	| { status: "succeeded"; image: ImageGridItem }
	| { status: "pending"; message: string }
	| { status: "failed"; message: string; canRetry?: boolean };

/** Draft selection stays here until confirmed; browsing never starts generation. */
export function ImagePicker({
	images,
	selectedId,
	loading,
	error,
	pending,
	onRefresh,
	onConfirm,
	onCancel,
	onDelete,
	onUpload,
	savedOnly = false,
	renderGooglePhotos,
}: ImagePickerProps) {
	const [draftId, setDraftId] = useState(selectedId);
	const [previewId, setPreviewId] = useState<string>();
	const [deleteId, setDeleteId] = useState<string>();
	const [deleting, setDeleting] = useState(false);
	const [deleteError, setDeleteError] = useState("");
	const [gridRevision, setGridRevision] = useState(0);
	const [provider, setProvider] = useState("larm");
	const [file, setFile] = useState<{
		name: string;
		url: string;
		value: File;
		requestId: string;
	}>();
	const [uploading, setUploading] = useState(false);
	const [uploadResult, setUploadResult] = useState<ImagePickerUploadResult>();
	const [uploaded, setUploaded] = useState<ImageGridItem>();
	const current = useRef<AbortController | undefined>(undefined);
	const cancelUpload = () => {
		current.current?.abort();
		current.current = undefined;
		setUploading(false);
	};
	useEffect(() => () => current.current?.abort(), []);
	const fileInput = useRef<HTMLInputElement>(null);
	useEffect(() => {
		return () => {
			if (file) URL.revokeObjectURL(file.url);
		};
	}, [file]);
	const candidates =
		uploaded && !images.some((i) => i.id === uploaded.id)
			? [uploaded, ...images]
			: images;
	const selected = candidates.find(
		(image) => image.id === draftId && !image.disabledReason,
	);
	const preview = images.find((image) => image.id === previewId);
	const deleteTarget = candidates.find((image) => image.id === deleteId);
	async function upload(newAttempt = false) {
		if (!file || !onUpload) return;
		cancelUpload();
		const controller = new AbortController();
		current.current = controller;
		const requestId = newAttempt ? crypto.randomUUID() : file.requestId;
		if (newAttempt) setFile({ ...file, requestId });
		setUploading(true);
		setUploadResult(undefined);
		try {
			const result = await onUpload(file.value, requestId, controller.signal);
			if (controller.signal.aborted || current.current !== controller) return;
			setUploadResult(result);
			if (result.status === "succeeded") {
				setUploaded(result.image);
				setDraftId(result.image.id);
				setFile(undefined);
				onRefresh?.();
			}
		} catch {
			if (!controller.signal.aborted && current.current === controller)
				setUploadResult({
					status: "pending",
					message:
						"アップロード結果を確認できません。同じ受付番号で再確認してください。",
				});
		} finally {
			if (current.current === controller) {
				current.current = undefined;
				setUploading(false);
			}
		}
	}
	const leave = () => {
		cancelUpload();
		onCancel();
	};
	return (
		<section className="image-picker" aria-label="画像を選ぶ">
			<header className="image-picker-heading">
				<Button
					type="button"
					variant="ghost"
					onClick={preview ? () => setPreviewId(undefined) : leave}
				>
					{preview ? "画像一覧に戻る" : "戻る"}
				</Button>
				<h3>{preview ? preview.title : "画像を選ぶ"}</h3>
			</header>
			{preview && (
				<ImageFrame
					src={preview.thumbnailUrl}
					alt={preview.title}
					className="image-picker-preview"
				/>
			)}
			<div className="image-picker-content" hidden={!!preview}>
				{!savedOnly && (
					<>
						<div className="image-picker-toolbar">
							<span>端末の画像</span>
							<Button
								type="button"
								variant="outline"
								disabled={pending}
								onClick={() => fileInput.current?.click()}
							>
								参照…
							</Button>
							<input
								ref={fileInput}
								type="file"
								hidden
								aria-label="アップロードする画像"
								accept="image/jpeg,image/png,image/webp"
								disabled={pending}
								onChange={(event) => {
									const picked = event.target.files?.[0];
									event.target.value = "";
									if (!picked) return;
									cancelUpload();
									setUploadResult(undefined);
									setFile({
										name: picked.name,
										url: URL.createObjectURL(picked),
										value: picked,
										requestId: crypto.randomUUID(),
									});
									setDraftId(undefined);
								}}
							/>
						</div>
						<p className="image-picker-note">
							{onUpload
								? "長辺2000px以内・WebP品質75に変換して保存します。選択だけでは3D生成しません。"
								: "ファイルの選択・確認ができます。アップロードは画像取込機能の対応待ちです。"}
						</p>
					</>
				)}
				{file && (
					<div className="image-picker-local">
						<ImageFrame
							src={file.url}
							alt={file.name}
							className="image-picker-preview"
						/>
						<p role="status">
							{file.name}：
							{onUpload
								? "保存するにはアップロードしてください。"
								: "未アップロード。この画像はまだ3D生成に使えません。"}
						</p>
						{onUpload && (
							<Button
								type="button"
								disabled={
									uploading ||
									pending ||
									(uploadResult?.status === "failed" && !uploadResult.canRetry)
								}
								onClick={() =>
									void upload(
										uploadResult?.status === "failed" &&
											!!uploadResult.canRetry,
									)
								}
							>
								{uploading
									? "アップロード結果を確認中…"
									: uploadResult?.status === "pending"
										? "状態を再確認"
										: uploadResult?.status === "failed" && uploadResult.canRetry
											? "もう一度アップロード"
											: "アップロード"}
							</Button>
						)}
						{uploadResult && uploadResult.status !== "succeeded" && (
							<p role="status">{uploadResult.message}</p>
						)}
						<Button
							type="button"
							variant="outline"
							onClick={() => {
								cancelUpload();
								setFile(undefined);
								setUploadResult(undefined);
							}}
						>
							ファイル選択を解除
						</Button>
					</div>
				)}
				<Tabs value={provider} onValueChange={setProvider}>
					{!savedOnly && (
						<TabsList
							className="image-picker-sources"
							aria-label="画像の提供元"
						>
							<TabsTrigger value="larm">LARM画像</TabsTrigger>
							<TabsTrigger value="google">Googleフォト</TabsTrigger>
						</TabsList>
					)}
					<TabsContent value="larm">
						<div className="image-picker-toolbar">
							<span>保存した画像　{images.length}枚</span>
							{onRefresh && (
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={loading || pending}
									onClick={() => {
										setGridRevision((value) => value + 1);
										onRefresh();
									}}
								>
									一覧を更新
								</Button>
							)}
						</div>
						{loading && <output>画像を読み込んでいます。</output>}
						{error && <p role="alert">{error}</p>}
						{!loading && !error && !images.length && (
							<p>保存した画像がありません。</p>
						)}
						<ImageGrid
							mode="select"
							key={gridRevision}
							images={candidates}
							selectedId={selected?.id}
							disabled={pending}
							onSelect={(id) => {
								cancelUpload();
								setUploadResult(undefined);
								setDraftId(id);
								setFile(undefined);
							}}
							onPreview={setPreviewId}
							renderActions={(image) => (
								<>
									{image.thumbnailUrl && (
										<a
											className="image-download"
											href={image.thumbnailUrl}
											download
											aria-label={`${image.title}をダウンロード`}
										>
											<Download aria-hidden="true" />
										</a>
									)}
									{onDelete && (
										<Button
											type="button"
											variant="ghost"
											size="icon"
											aria-label={`${image.title}を削除`}
											disabled={pending || deleting}
											onClick={() => {
												setDeleteError("");
												setDeleteId(image.id);
											}}
										>
											<Trash2 aria-hidden="true" />
										</Button>
									)}
								</>
							)}
						/>
					</TabsContent>
					<TabsContent value="google">
						{renderGooglePhotos ? (
							<GooglePhotosPane
								render={renderGooglePhotos}
								onSelect={(image) => {
									cancelUpload();
									setFile(undefined);
									setUploadResult(undefined);
									setUploaded(image);
									setDraftId(image.id);
									setProvider("larm");
									onRefresh?.();
								}}
							/>
						) : (
							<p role="status">
								Googleフォトの写真選択はこの表示では利用できません。
							</p>
						)}
					</TabsContent>
				</Tabs>
			</div>
			<footer className="image-picker-footer">
				<span aria-live="polite">
					{selected ? "1枚選択中" : "画像を選んでください"}
				</span>
				<Button type="button" variant="outline" onClick={leave}>
					キャンセル
				</Button>
				<Button
					type="button"
					disabled={!selected || uploading || pending || loading || !!error}
					onClick={() => {
						if (selected) onConfirm(selected.id);
					}}
				>
					この画像を使う
				</Button>
			</footer>
			<Modal
				open={!!deleteTarget && !!onDelete}
				title="画像を削除しますか？"
				description="保存した画像を完全に削除します。この操作は取り消せません。"
				onOpenChange={(open) => {
					if (!open && !deleting) setDeleteId(undefined);
				}}
			>
				<p>「{deleteTarget?.title}」</p>
				{deleteError && <p role="alert">{deleteError}</p>}
				<div className="image-gallery-delete-actions">
					<Button
						type="button"
						variant="secondary"
						disabled={deleting}
						onClick={() => setDeleteId(undefined)}
					>
						キャンセル
					</Button>
					<Button
						type="button"
						variant="destructive"
						disabled={deleting || pending || !deleteTarget}
						onClick={async () => {
							if (!deleteTarget || !onDelete || deleting) return;
							const id = deleteTarget.id;
							setDeleting(true);
							try {
								if (await onDelete(id)) {
									setDraftId((currentId) =>
										currentId === id ? undefined : currentId,
									);
									setUploaded((currentImage) =>
										currentImage?.id === id ? undefined : currentImage,
									);
									setDeleteId(undefined);
								} else
									setDeleteError(
										"削除結果を確認できませんでした。一覧を更新してください。",
									);
							} catch {
								setDeleteError(
									"削除結果を確認できませんでした。一覧を更新してください。",
								);
							} finally {
								setDeleting(false);
							}
						}}
					>
						削除する
					</Button>
				</div>
			</Modal>
		</section>
	);
}

function GooglePhotosPane({
	render,
	onSelect,
}: {
	render: NonNullable<ImagePickerProps["renderGooglePhotos"]>;
	onSelect: (image: ImageGridItem) => void;
}) {
	return <>{render(onSelect)}</>;
}
