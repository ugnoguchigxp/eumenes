import { useId, useState } from "react";
import { Button } from "../Button";
import { Input } from "../Input";
import { Textarea } from "../Textarea";
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
	pending,
	onGenerate,
}: Model3dGenerationFormProps) {
	const id = useId();
	const [draft, setDraft] = useState<Draft>(empty);
	const [submitted, setSubmitted] = useState(false);
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
		<form
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
			<label htmlFor={`${id}-title`}>タイトル</label>
			<Input
				id={`${id}-title`}
				value={draft.title}
				maxLength={titleLimit}
				disabled={disabled}
				onChange={(event) => setDraft({ ...draft, title: event.target.value })}
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
				<fieldset className="model3d-images" disabled={disabled}>
					<legend>画像を選ぶ</legend>
					{sourceImagesLoading && <output>画像を読み込んでいます。</output>}
					{!sourceImagesLoading && !sourceImages.length && (
						<p>保存した画像がありません。</p>
					)}
					<div className="model3d-image-choices">
						{sourceImages.map((image) => (
							<label key={image.id} data-selected={draft.imageId === image.id}>
								<input
									type="radio"
									name={`${id}-image`}
									checked={draft.imageId === image.id}
									onChange={() => setDraft({ ...draft, imageId: image.id })}
								/>
								{image.thumbnailUrl ? (
									<img src={image.thumbnailUrl} alt="" />
								) : (
									<span className="model3d-thumb-empty" aria-hidden="true" />
								)}
								<span>{image.title}</span>
							</label>
						))}
					</div>
				</fieldset>
			)}
			{error && <p role="alert">{error}</p>}
			<Button type="submit" disabled={disabled}>
				3Dモデルを生成する
			</Button>
		</form>
	);
}
