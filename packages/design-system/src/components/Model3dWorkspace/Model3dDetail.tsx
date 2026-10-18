import { useId, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "../Button";
import { Input } from "../Input";
import { parseTags } from "./Model3dLibrary";
import {
	model3dQualityNote,
	type Model3dAssetItem,
	type Model3dSubmitResult,
	type Model3dUpdateValues,
} from "./types";

export type Model3dDetailProps = {
	asset: Model3dAssetItem;
	viewer?: ReactNode;
	pending?: boolean;
	onUpdate: (values: Model3dUpdateValues) => Model3dSubmitResult;
	onDelete: (id: string) => void;
};

/** Title and tag edits are drafts per asset; deletion needs an explicit confirmation. */
export function Model3dDetail({
	asset,
	viewer,
	pending,
	onUpdate,
	onDelete,
}: Model3dDetailProps) {
	const id = useId();
	const saved = { title: asset.title, tags: asset.tags.join("、") };
	const [draft, setDraft] = useState<{
		assetId: string;
		title: string;
		tags: string;
	}>();
	const edit =
		draft?.assetId === asset.id ? draft : { assetId: asset.id, ...saved };
	const [confirming, setConfirming] = useState<string>();
	const dirty =
		edit.title.trim() !== saved.title ||
		parseTags(edit.tags).join("、") !== saved.tags;
	const valid = edit.title.trim().length > 0;
	return (
		<section className="model3d-detail" aria-label={`${asset.title}の詳細`}>
			<div className="model3d-viewer">{viewer}</div>
			<p className="model3d-note">{model3dQualityNote}</p>
			{asset.warnings.length > 0 && (
				<div className="model3d-warning-box" role="status">
					<strong>この3Dモデルの注意点</strong>
					<ul className="model3d-warnings">
						{asset.warnings.map((warning, index) => (
							<li key={`${index}:${warning}`}>{warning}</li>
						))}
					</ul>
				</div>
			)}
			<form
				className="model3d-edit"
				aria-label="タイトルとタグの編集"
				onSubmit={(event) => {
					event.preventDefault();
					if (!dirty || !valid) return;
					void onUpdate({
						id: asset.id,
						title: edit.title.trim(),
						tags: edit.tags.trim(),
					});
				}}
			>
				<label htmlFor={`${id}-title`}>タイトル</label>
				<Input
					id={`${id}-title`}
					value={edit.title}
					maxLength={80}
					onChange={(event) => setDraft({ ...edit, title: event.target.value })}
				/>
				<label htmlFor={`${id}-tags`}>
					タグ <small>（読点またはカンマ区切り）</small>
				</label>
				<Input
					id={`${id}-tags`}
					value={edit.tags}
					maxLength={240}
					onChange={(event) => setDraft({ ...edit, tags: event.target.value })}
				/>
				<Button type="submit" disabled={pending || !dirty || !valid}>
					変更を保存
				</Button>
			</form>
			{asset.prompt && (
				<p className="model3d-prompt">
					<span>元の文章</span>
					{asset.prompt}
				</p>
			)}
			<div className="model3d-actions">
				{asset.downloadUrl && (
					<a
						className="model3d-download"
						href={asset.downloadUrl}
						download={`${asset.title}.glb`}
					>
						GLBをダウンロード
					</a>
				)}
				{confirming !== asset.id && (
					<Button
						type="button"
						variant="outline-destructive"
						disabled={pending}
						onClick={() => setConfirming(asset.id)}
					>
						削除する
					</Button>
				)}
			</div>
			{confirming === asset.id && (
				<div
					className="model3d-confirm"
					role="alertdialog"
					aria-label="削除の確認"
				>
					<p>「{asset.title}」を完全に削除します。この操作は取り消せません。</p>
					<div className="model3d-actions">
						<Button
							type="button"
							variant="outline"
							onClick={() => setConfirming(undefined)}
						>
							キャンセル
						</Button>
						<Button
							type="button"
							variant="destructive"
							disabled={pending}
							onClick={() => {
								setConfirming(undefined);
								onDelete(asset.id);
							}}
						>
							削除を確定
						</Button>
					</div>
				</div>
			)}
		</section>
	);
}
