import { useEffect, useRef, useState } from "react";
import { Button } from "../Button";
import { ImageFrame } from "../ImageViewer/ImageFrame";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../Tabs";
import { ImageGrid, type ImageGridItem } from "./ImageGrid";

export type ImagePickerProps = {
	images: readonly ImageGridItem[];
	selectedId?: string;
	loading?: boolean;
	error?: string;
	pending?: boolean;
	onRefresh?: () => void;
	onConfirm: (id: string) => void;
	onCancel: () => void;
};

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
}: ImagePickerProps) {
	const [draftId, setDraftId] = useState(selectedId);
	const [previewId, setPreviewId] = useState<string>();
	const [gridRevision, setGridRevision] = useState(0);
	const [provider, setProvider] = useState("larm");
	const [file, setFile] = useState<{ name: string; url: string }>();
	const fileInput = useRef<HTMLInputElement>(null);
	useEffect(() => {
		return () => {
			if (file) URL.revokeObjectURL(file.url);
		};
	}, [file]);
	const selected = images.find((image) => image.id === draftId);
	const preview = images.find((image) => image.id === previewId);
	return (
		<section className="image-picker" aria-label="画像を選ぶ">
			<header className="image-picker-heading">
				<Button
					type="button"
					variant="ghost"
					onClick={preview ? () => setPreviewId(undefined) : onCancel}
				>
					{preview ? "画像一覧に戻る" : "戻る"}
				</Button>
				<h3>{preview ? preview.title : "画像を選ぶ"}</h3>
			</header>
			{preview ? (
				<ImageFrame
					src={preview.thumbnailUrl}
					alt={preview.title}
					className="image-picker-preview"
				/>
			) : (
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
								setFile({
									name: picked.name,
									url: URL.createObjectURL(picked),
								});
								setDraftId(undefined);
							}}
						/>
					</div>
					<p className="image-picker-note">
						ファイルの選択・確認ができます。アップロードは画像取込機能の対応待ちです。
					</p>
					{file && (
						<div className="image-picker-local">
							<ImageFrame
								src={file.url}
								alt={file.name}
								className="image-picker-preview"
							/>
							<p role="status">
								{file.name}：未アップロード。この画像はまだ3D生成に使えません。
							</p>
							<Button
								type="button"
								variant="outline"
								onClick={() => setFile(undefined)}
							>
								ファイル選択を解除
							</Button>
						</div>
					)}
					<Tabs value={provider} onValueChange={setProvider}>
						<TabsList
							className="image-picker-sources"
							aria-label="画像の提供元"
						>
							<TabsTrigger value="larm">LARM画像</TabsTrigger>
							<TabsTrigger value="google">Googleフォト</TabsTrigger>
						</TabsList>
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
								key={gridRevision}
								images={images}
								selectedId={selected?.id}
								disabled={pending}
								onSelect={(id) => {
									setDraftId(id);
									setFile(undefined);
								}}
								onPreview={setPreviewId}
							/>
						</TabsContent>
						<TabsContent value="google">
							<p role="status">
								Googleフォトからの選択は未実装です。現在のGoogle連携はプロフィール用です。写真を選べるようにするためのアプリ側の対応が必要です。
							</p>
						</TabsContent>
					</Tabs>
				</>
			)}
			<footer className="image-picker-footer">
				<span aria-live="polite">
					{selected ? "1枚選択中" : "画像を選んでください"}
				</span>
				<Button type="button" variant="outline" onClick={onCancel}>
					キャンセル
				</Button>
				<Button
					type="button"
					disabled={!selected || pending || loading || !!error}
					onClick={() => {
						if (selected) onConfirm(selected.id);
					}}
				>
					この画像を使う
				</Button>
			</footer>
		</section>
	);
}
