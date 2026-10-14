import { useId, useState } from "react";
import { Search, Sparkles, X } from "lucide-react";
import { Button } from "../Button";
import { Input } from "../Input";
import { Textarea } from "../Textarea";
import type { ImagePromptValues } from "./types";
import {
	emptyImageSelection,
	imageSelectionText,
	defaultImageCreationOptions,
	type ImageCreationOptions,
	type ImageSelection,
} from "./image-creation-options";
import "./ImageCreationForm.css";
export type ImageCreationFormProps = {
	initialValues: ImagePromptValues;
	creationOptions?: ImageCreationOptions;
	busy?: boolean;
	pending?: boolean;
	onGenerate: (values: ImagePromptValues) => void;
};
function Choices({
	label,
	options,
	selected,
	disabled,
	onChange,
}: {
	label: string;
	options: readonly string[];
	selected: string[];
	disabled?: boolean;
	onChange: (selected: string[]) => void;
}) {
	return (
		<fieldset className="image-creation-choices" disabled={disabled}>
			<legend>{label}</legend>
			<div>
				{options.map((option) => (
					<label key={option}>
						<input
							type="checkbox"
							checked={selected.includes(option)}
							onChange={(event) =>
								onChange(
									event.target.checked
										? [...selected, option]
										: selected.filter((value) => value !== option),
								)
							}
						/>
						<span>{option}</span>
					</label>
				))}
			</div>
		</fieldset>
	);
}
function ChoiceSelect({
	label,
	value,
	options,
	disabled,
	onChange,
}: {
	label: string;
	value: string;
	options: readonly string[];
	disabled?: boolean;
	onChange: (value: string) => void;
}) {
	return (
		<label className="image-creation-select">
			<span>{label}</span>
			<select
				aria-label={label}
				value={value}
				disabled={disabled}
				onChange={(event) => onChange(event.target.value)}
			>
				{options.map((option) => (
					<option key={option}>{option}</option>
				))}
			</select>
		</label>
	);
}

function ImageParameters({
	id,
	parameters,
	setParameters,
	disabled,
}: {
	id: string;
	parameters: Omit<ImagePromptValues, "prompt">;
	setParameters: (parameters: Omit<ImagePromptValues, "prompt">) => void;
	disabled?: boolean;
}) {
	return (
		<div className="image-creation-parameters">
			<label htmlFor={`${id}-width`}>
				幅（px）
				<Input
					id={`${id}-width`}
					type="number"
					min={100}
					max={1280}
					step={1}
					required
					disabled={disabled}
					value={parameters.width}
					onChange={(event) =>
						setParameters({
							...parameters,
							width: Number(event.target.value),
						})
					}
				/>
			</label>
			<label htmlFor={`${id}-height`}>
				高さ（px）
				<Input
					id={`${id}-height`}
					type="number"
					min={100}
					max={1280}
					step={1}
					required
					disabled={disabled}
					value={parameters.height}
					onChange={(event) =>
						setParameters({
							...parameters,
							height: Number(event.target.value),
						})
					}
				/>
			</label>
			<label htmlFor={`${id}-format`}>
				保存形式
				<select
					id={`${id}-format`}
					disabled={disabled}
					value={parameters.format}
					onChange={(event) =>
						setParameters({
							...parameters,
							format: event.target.value as "png" | "webp",
						})
					}
				>
					<option value="webp">WebP</option>
					<option value="png">PNG</option>
				</select>
			</label>
			<label htmlFor={`${id}-seed`}>
				シード
				<Input
					id={`${id}-seed`}
					type="number"
					min={0}
					max={Number.MAX_SAFE_INTEGER}
					step={1}
					required
					disabled={disabled}
					value={parameters.seed}
					onChange={(event) =>
						setParameters({
							...parameters,
							seed: Number(event.target.value),
						})
					}
				/>
			</label>
		</div>
	);
}
/** Like MusicCreationForm, choices assemble the draft and manual edits require an explicit replacement decision. */
export function ImageCreationForm({
	initialValues,
	creationOptions = defaultImageCreationOptions,
	busy,
	pending: sending,
	onGenerate,
}: ImageCreationFormProps) {
	const id = useId();
	const [selection, setSelection] = useState(() => emptyImageSelection(creationOptions));
	const [parameters, setParameters] = useState(() => ({
		width: initialValues.width,
		height: initialValues.height,
		format: initialValues.format,
		seed: initialValues.seed,
	}));
	const [prompt, setPrompt] = useState(initialValues.prompt);
	const [edited, setEdited] = useState(!!initialValues.prompt);
	const [pending, setPending] = useState(false);
	const [previous, setPrevious] = useState<string>();
	const [search, setSearch] = useState("");
	const disabled = busy || sending;
	const update = (next: ImageSelection) => {
		setSelection(next);
		if (edited) setPending(true);
		else setPrompt(imageSelectionText(next, creationOptions));
	};
	const reflect = () => {
		setPrevious(prompt);
		setPrompt(imageSelectionText(selection, creationOptions));
		setEdited(false);
		setPending(false);
	};
	const reset = () => {
		setPrevious(prompt);
		setSelection(emptyImageSelection(creationOptions));
		setParameters({ ...creationOptions.defaults });
		setPrompt("");
		setEdited(false);
		setPending(false);
		setSearch("");
	};
	const groups = creationOptions.styleGroups
		.map((group) => ({
			...group,
			options: group.options.filter((option) =>
				option.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
			),
		}))
		.filter((group) => group.options.length);
	return (
		<form
			className="image-creation-form"
			aria-label="画像の制作設定"
			onSubmit={(event) => {
				event.preventDefault();
				if (!disabled && !pending && prompt.trim() && prompt.length <= 7600)
					onGenerate({ ...parameters, prompt: prompt.trim() });
			}}
		>
			<div className="image-creation-settings">
				<header className="image-creation-heading">
					<h3>どんな画像にしますか？</h3>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={reset}
						disabled={disabled}
					>
						リセット
					</Button>
				</header>
				<label className="image-creation-theme" htmlFor={`${id}-theme`}>
					テーマ・描きたいもの
					<Input
						id={`${id}-theme`}
						value={selection.theme}
						disabled={disabled}
						maxLength={4000}
						placeholder="朝の光が差し込む、静かな書斎"
						onChange={(event) =>
							update({ ...selection, theme: event.target.value })
						}
					/>
				</label>
				<div className="image-creation-style-heading">
					<h4>
						画風 <small>複数選択できます</small>
					</h4>
					<label className="image-creation-search">
						<Search aria-hidden="true" />
						<input
							aria-label="画風を探す"
							placeholder="画風を探す"
							value={search}
							disabled={disabled}
							onChange={(event) => setSearch(event.target.value)}
						/>
					</label>
				</div>
				<div className="image-creation-styles">
					{groups.map((group) => (
						<Choices
							key={group.label}
							label={group.label}
							options={group.options}
							selected={selection.styles}
							disabled={disabled}
							onChange={(styles) => update({ ...selection, styles })}
						/>
					))}
					{!groups.length && <p>該当する画風はありません。</p>}
				</div>
				{selection.styles.length > 0 && (
					<div className="image-creation-selected" aria-label="選択した画風">
						{selection.styles.map((style) => (
							<Button
								key={style}
								type="button"
								size="sm"
								variant="secondary"
								disabled={disabled}
								aria-label={`${style}を解除`}
								onClick={() =>
									update({
										...selection,
										styles: selection.styles.filter((value) => value !== style),
									})
								}
							>
								{style}
								<X aria-hidden="true" />
							</Button>
						))}
					</div>
				)}
				<Choices
					label="雰囲気"
					options={creationOptions.moods}
					selected={selection.moods}
					disabled={disabled}
					onChange={(moods) => update({ ...selection, moods })}
				/>
				<div className="image-creation-selects">
					<ChoiceSelect
						label="構図"
						value={selection.composition}
						options={creationOptions.compositions}
						disabled={disabled}
						onChange={(composition) => update({ ...selection, composition })}
					/>
					<ChoiceSelect
						label="光"
						value={selection.light}
						options={creationOptions.lighting}
						disabled={disabled}
						onChange={(light) => update({ ...selection, light })}
					/>
				</div>
				<ImageParameters
					id={id}
					parameters={parameters}
					setParameters={setParameters}
					disabled={disabled}
				/>
			</div>
			<section
				className="image-creation-prompt"
				aria-label="画像作成プロンプトの編集"
			>
				<div className="image-creation-prompt-heading">
					<label htmlFor={`${id}-prompt`}>画像作成プロンプト</label>
					<span>{edited ? "編集中" : "選択内容と同期"}</span>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={reflect}
						disabled={disabled}
					>
						選択内容を反映
					</Button>
				</div>
				{pending && (
					<div className="image-creation-update" role="status">
						<p>
							手入力を保護しています。反映すると文章を選択内容に置き換えます。
						</p>
						<details>
							<summary>選択内容の更新候補</summary>
							<pre>{imageSelectionText(selection, creationOptions)}</pre>
						</details>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							disabled={disabled}
							onClick={() => setPending(false)}
						>
							編集内容を使う
						</Button>
					</div>
				)}
				<Textarea
					id={`${id}-prompt`}
					value={prompt}
					disabled={disabled}
					maxLength={7600}
					rows={5}
					placeholder="選択内容から作成した文章を、自由に編集できます"
					onChange={(event) => {
						setPrompt(event.target.value);
						setEdited(true);
					}}
				/>
				<div className="image-creation-actions">
					<span>自由に編集できます</span>
					{previous !== undefined && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={disabled}
							onClick={() => {
								setPrompt(previous);
								setPrevious(undefined);
								setEdited(true);
								setPending(false);
							}}
						>
							編集内容に戻す
						</Button>
					)}
					<Button
						type="submit"
						disabled={
							disabled || pending || !prompt.trim() || prompt.length > 7600
						}
					>
						<Sparkles aria-hidden="true" />
						{busy ? "生成処理中" : "画像を生成"}
					</Button>
				</div>
			</section>
		</form>
	);
}
