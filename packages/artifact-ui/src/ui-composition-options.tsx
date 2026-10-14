import { Input } from "@eumenes/design-system";
import { FileText, Image, LayoutTemplate } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useArtifactRuntime } from "./runtime";

export type UiSelection = {
	purpose: string;
	screenType: string;
	elements: string[];
	moods: string[];
};
export const emptyUiSelection: UiSelection = {
	purpose: "",
	screenType: "",
	elements: [],
	moods: [],
};
const screenTypes = [
	{ label: "フォーム", detail: "入力と送信", icon: FileText },
	{ label: "案内", detail: "情報を伝える", icon: LayoutTemplate },
	{ label: "情報カード", detail: "内容をまとめる", icon: Image },
] as const;
const elements = [
	"テキスト入力",
	"ラジオ選択",
	"チェックボックス選択",
	"自由記述欄",
	"送信ボタン",
] as const;
const moods = ["すっきり", "温かい", "上品", "親しみやすい"] as const;

export function uiSelectionText(
	selection: UiSelection,
	hasMotif: boolean,
): string {
	const lines = [
		selection.purpose.trim() ? `用途・目的: ${selection.purpose.trim()}。` : "",
		selection.screenType ? `画面の種類: ${selection.screenType}。` : "",
		selection.elements.length
			? `必要な要素: ${selection.elements.join("、")}。`
			: "",
		selection.moods.length ? `雰囲気: ${selection.moods.join("、")}。` : "",
		hasMotif ? "選択したモチーフ画像を見た目の参考にしてください。" : "",
	];
	return lines.filter(Boolean).join("\n");
}

function MotifImage({ id, title }: { id: string; title: string }) {
	const { fetchMedia } = useArtifactRuntime();
	const [url, setUrl] = useState<string>();
	useEffect(() => {
		if (!fetchMedia) return;
		let active = true;
		let objectUrl: string | undefined;
		void fetchMedia(`/api/images/${encodeURIComponent(id)}/content`)
			.then((blob) => {
				objectUrl = URL.createObjectURL(blob);
				if (active) setUrl(objectUrl);
				else URL.revokeObjectURL(objectUrl);
			})
			.catch(() => {
				if (active) setUrl(undefined);
			});
		return () => {
			active = false;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [fetchMedia, id]);
	return url ? <img src={url} alt={title} /> : <Image aria-hidden="true" />;
}

export function UiOptions({
	selection,
	onSelection,
	images,
	motifId,
	onMotif,
}: {
	selection: UiSelection;
	onSelection: (next: UiSelection) => void;
	images: Array<{ id: string; title?: string }>;
	motifId: string;
	onMotif: (id: string) => void;
}) {
	const inputId = useId();
	return (
		<>
			<div className="aui-ui-control">
				<div className="aui-ui-label">
					<label htmlFor={`${inputId}-purpose`}>
						1. どんな目的で使いますか？
					</label>
					<span>任意</span>
				</div>
				<Input
					id={`${inputId}-purpose`}
					value={selection.purpose}
					maxLength={200}
					placeholder="例：イベントの来場者から感想を集める"
					onChange={(event) =>
						onSelection({ ...selection, purpose: event.target.value })
					}
				/>
				<small>{selection.purpose.length} / 200</small>
			</div>
			<fieldset className="aui-ui-control">
				<legend className="aui-ui-label">2. 画面の種類を選びましょう</legend>
				<div className="aui-ui-type-grid">
					{screenTypes.map((option) => {
						const Icon = option.icon;
						return (
							<button
								type="button"
								className="aui-ui-type"
								aria-pressed={selection.screenType === option.label}
								key={option.label}
								onClick={() =>
									onSelection({ ...selection, screenType: option.label })
								}
							>
								<Icon aria-hidden="true" />
								<strong>{option.label}</strong>
								<span>{option.detail}</span>
							</button>
						);
					})}
				</div>
			</fieldset>
			<fieldset className="aui-ui-control">
				<legend className="aui-ui-label">3. 必要な要素を選びましょう</legend>
				<div className="aui-ui-chip-list">
					{elements.map((option) => (
						<label className="aui-ui-chip" key={option}>
							<input
								type="checkbox"
								checked={selection.elements.includes(option)}
								onChange={(event) =>
									onSelection({
										...selection,
										elements: event.target.checked
											? [...selection.elements, option]
											: selection.elements.filter((value) => value !== option),
									})
								}
							/>
							<span>{option}</span>
						</label>
					))}
				</div>
			</fieldset>
			<fieldset className="aui-ui-control">
				<legend className="aui-ui-label">
					4. モチーフとなる画像を選びましょう <span>任意</span>
				</legend>
				{images.length ? (
					<div className="aui-ui-motif-list">
						<button
							type="button"
							className="aui-ui-motif-none"
							aria-pressed={!motifId}
							onClick={() => onMotif("")}
						>
							<Image aria-hidden="true" />
							<span>選択しない</span>
						</button>
						{images.map((image) => (
							<button
								type="button"
								className="aui-ui-motif"
								aria-label={image.title || image.id}
								aria-pressed={motifId === image.id}
								key={image.id}
								onClick={() => onMotif(image.id)}
							>
								<MotifImage
									id={image.id}
									title={image.title || "モチーフ画像"}
								/>
								<span>{image.title || "画像"}</span>
							</button>
						))}
					</div>
				) : (
					<p className="aui-ui-hint">
						画像作品を作ると、ここからモチーフに選べます。
					</p>
				)}
			</fieldset>
			<fieldset className="aui-ui-control">
				<legend className="aui-ui-label">
					5. 雰囲気を選びましょう <span>任意・複数選択可</span>
				</legend>
				<div className="aui-ui-chip-list">
					{moods.map((option) => (
						<label className="aui-ui-chip" key={option}>
							<input
								type="checkbox"
								checked={selection.moods.includes(option)}
								onChange={(event) =>
									onSelection({
										...selection,
										moods: event.target.checked
											? [...selection.moods, option]
											: selection.moods.filter((value) => value !== option),
									})
								}
							/>
							<span>{option}</span>
						</label>
					))}
				</div>
			</fieldset>
		</>
	);
}
