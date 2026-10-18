import { useId, useState } from "react";
import { Button } from "../Button";
import { Input } from "../Input";
import { Textarea } from "../Textarea";
import { ImagePicker } from "../ImagePicker";
import type {
	Model3dGenerateValues,
	Model3dSourceImage,
	Model3dSubmitResult,
} from "./types";

const titleLimit = 80;
const tagsLimit = 240;
const promptLimit = 2000;

export type Model3dGenerationFormProps = {
	available: boolean;
	unavailableReason?: string | null;
	sourceImages: readonly Model3dSourceImage[];
	sourceImagesLoading?: boolean;
	sourceImagesError?: string;
	onRefreshImages?: () => void;
	pending?: boolean;
	onGenerate: (values: Model3dGenerateValues) => Model3dSubmitResult;
};

type Draft = {
	mode: "prompt" | "image";
	title: string;
	tags: string;
	prompt: string;
	imageId: string;
};
const empty: Draft = {
	mode: "prompt",
	title: "",
	tags: "",
	prompt: "",
	imageId: "",
};

function problem(draft: Draft): string | undefined {
	if (!draft.title.trim()) return "タイトルを入力してください。";
	if (draft.mode === "prompt" && !draft.prompt.trim())
		return "作りたいものを文章で入力してください。";
	if (draft.mode === "image" && !draft.imageId)
		return "元にする画像を選んでください。";
	return undefined;
}

/** Local form state only. The host decides whether the request is accepted. */
export function Model3dGenerationForm({
	available,
	unavailableReason,
	sourceImages,
	sourceImagesLoading,
	sourceImagesError,
	onRefreshImages,
	pending,
	onGenerate,
}: Model3dGenerationFormProps) {
	const id = useId();
	const [draft, setDraft] = useState<Draft>(empty);
	const [submitted, setSubmitted] = useState(false);
	const [picking, setPicking] = useState(false);
	const selectedImage = sourceImages.find(
		(image) => image.id === draft.imageId,
	);
	const error = submitted ? problem(draft) : undefined;
	const disabled = !available || pending;
	async function submit() {
		setSubmitted(true);
		if (problem(draft)) return;
		const accepted = await onGenerate({
			title: draft.title.trim(),
			tags: draft.tags.trim(),
			prompt: draft.mode === "prompt" ? draft.prompt.trim() : "",
			imageId: draft.mode === "image" ? draft.imageId : "",
		});
		if (accepted === true) {
			setDraft(empty);
			setSubmitted(false);
		}
	}
	return (
		<section>
			<form
				hidden={picking}
				className="model3d-form"
				aria-label="3Dモデルの生成"
				onSubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
			>
				<h3>3Dモデルを作る</h3>
				{!available && (
					<p role="alert" className="model3d-unavailable">
						現在は生成できません。{unavailableReason ? unavailableReason : ""}
					</p>
				)}
				<fieldset className="model3d-mode" disabled={disabled}>
					<legend>元になるもの</legend>
					<label>
						<input
							type="radio"
							name={`${id}-mode`}
							checked={draft.mode === "prompt"}
							onChange={() => setDraft({ ...draft, mode: "prompt" })}
						/>
						文章から作る
					</label>
					<label>
						<input
							type="radio"
							name={`${id}-mode`}
							checked={draft.mode === "image"}
							onChange={() => setDraft({ ...draft, mode: "image" })}
						/>
						保存した画像から作る
					</label>
				</fieldset>
				{draft.mode === "prompt" ? (
					<>
						<label htmlFor={`${id}-prompt`}>作りたいもの</label>
						<Textarea
							id={`${id}-prompt`}
							value={draft.prompt}
							maxLength={promptLimit}
							rows={4}
							disabled={disabled}
							onChange={(event) =>
								setDraft({ ...draft, prompt: event.target.value })
							}
						/>
					</>
				) : (
					<div className="model3d-image-source">
						{selectedImage && (
							<div className="model3d-selected-image">
								{selectedImage.thumbnailUrl && (
									<img src={selectedImage.thumbnailUrl} alt="" />
								)}
								<span>{selectedImage.title}</span>
							</div>
						)}
						<Button
							type="button"
							variant="outline"
							disabled={disabled}
							onClick={() => setPicking(true)}
						>
							{selectedImage ? "画像を変更" : "画像を選ぶ"}
						</Button>
					</div>
				)}
				<label htmlFor={`${id}-title`}>タイトル</label>
				<Input
					id={`${id}-title`}
					value={draft.title}
					maxLength={titleLimit}
					disabled={disabled}
					onChange={(event) =>
						setDraft({ ...draft, title: event.target.value })
					}
				/>
				<label htmlFor={`${id}-tags`}>
					タグ <small>（読点またはカンマ区切り）</small>
				</label>
				<Input
					id={`${id}-tags`}
					value={draft.tags}
					maxLength={tagsLimit}
					disabled={disabled}
					onChange={(event) => setDraft({ ...draft, tags: event.target.value })}
				/>

				{error && <p role="alert">{error}</p>}
				<Button type="submit" disabled={disabled}>
					3Dモデルを生成する
				</Button>
			</form>
			{picking && (
				<ImagePicker
					images={sourceImages}
					selectedId={draft.imageId}
					loading={sourceImagesLoading}
					error={sourceImagesError}
					pending={disabled}
					onRefresh={onRefreshImages}
					onCancel={() => setPicking(false)}
					onConfirm={(imageId) => {
						setDraft({ ...draft, imageId });
						setPicking(false);
					}}
				/>
			)}
		</section>
	);
}
