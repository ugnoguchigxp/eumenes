import { useId, useState, type FormEvent } from "react";
import { Button } from "../Button";
import { Input } from "../Input";
import { Textarea } from "../Textarea";

export type VideoDraft = {
	prompt: string;
	title?: string;
	seed?: number;
	width?: number;
	height?: number;
	durationSeconds?: number;
};
export type VideoSettings = {
	sizes: readonly { width: number; height: number }[];
	durations: readonly number[];
};

const styles = ["実写風", "アニメ", "水彩"];
const moods = ["穏やか", "明るい", "幻想的"];
const cameras = ["固定", "横から追う", "ゆっくり近づく"];

type Scene = {
	scene: string;
	styles: string[];
	moods: string[];
	motion: string;
	camera: string;
	sound: string;
};
const emptyScene: Scene = {
	scene: "",
	styles: [],
	moods: [],
	motion: "",
	camera: "",
	sound: "",
};

function compose(scene: Scene) {
	const lines = [
		["場面", scene.scene.trim()],
		["画風", scene.styles.join("、")],
		["雰囲気", scene.moods.join("、")],
		["動き", scene.motion.trim()],
		["カメラ", scene.camera],
		["音", scene.sound.trim()],
	];
	return lines
		.filter(([, value]) => value)
		.map(([label, value]) => `${label}：${value}`)
		.join("\n");
}

function Choices({
	label,
	options,
	selected,
	onChange,
}: {
	label: string;
	options: string[];
	selected: string[];
	onChange(values: string[]): void;
}) {
	return (
		<fieldset className="ds-video-choices">
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
										? options.filter(
												(value) => value === option || selected.includes(value),
											)
										: selected.filter((value) => value !== option),
								)
							}
						/>
						{option}
					</label>
				))}
			</div>
		</fieldset>
	);
}
const sizeKey = ({ width, height }: { width: number; height: number }) =>
	`${width}×${height}`;

export function VideoCreationForm({
	options,
	canGenerate,
	pending,
	model,
	onGenerate,
}: {
	options?: VideoSettings;
	canGenerate: boolean;
	pending: boolean;
	model?: string;
	onGenerate(input: VideoDraft): void;
}) {
	const id = useId();
	const [scene, setScene] = useState(emptyScene);
	const [manual, setManual] = useState<string>();
	const [review, setReview] = useState(false);
	const [sizeId, setSize] = useState("");
	const [durationId, setDuration] = useState("");
	const size = sizeId
		? options?.sizes.find((value) => sizeKey(value) === sizeId)
		: options?.sizes[0];
	const duration = durationId
		? options?.durations.find((value) => String(value) === durationId)
		: options?.durations[0];
	const composed = compose(scene);
	const prompt = manual ?? composed;
	const canSubmit =
		canGenerate &&
		!pending &&
		!review &&
		!!size &&
		duration !== undefined &&
		!!prompt.trim() &&
		Array.from(prompt).length <= 8192;

	function update(next: Partial<Scene>) {
		const updated = { ...scene, ...next };
		setScene(updated);
		if (manual !== undefined && compose(updated) !== composed) setReview(true);
	}
	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!canSubmit) return;
		const fields = new FormData(event.currentTarget);
		const title = String(fields.get("title") ?? "").trim();
		const seed = String(fields.get("seed") ?? "");
		onGenerate({
			prompt: prompt.trim(),
			...(title ? { title } : {}),
			...(seed ? { seed: Number(seed) } : {}),
			...size,
			durationSeconds: duration,
		});
	}
	return (
		<form
			className="ds-video-card ds-video-form"
			aria-label="動画の制作設定"
			onSubmit={submit}
		>
			<h3>どんな動画にしますか？</h3>
			<label htmlFor={`${id}-scene`}>
				場面
				<Input
					id={`${id}-scene`}
					maxLength={3000}
					value={scene.scene}
					placeholder="朝の海辺を飛ぶカモメ"
					onChange={(event) => update({ scene: event.target.value })}
				/>
			</label>
			<Choices
				label="画風"
				options={styles}
				selected={scene.styles}
				onChange={(styles) => update({ styles })}
			/>
			<Choices
				label="雰囲気"
				options={moods}
				selected={scene.moods}
				onChange={(moods) => update({ moods })}
			/>
			<div className="ds-video-builder-fields">
				<label htmlFor={`${id}-motion`}>
					動き
					<Input
						id={`${id}-motion`}
						maxLength={2000}
						value={scene.motion}
						placeholder="波に沿って低く飛ぶ"
						onChange={(event) => update({ motion: event.target.value })}
					/>
				</label>
				<label>
					カメラ
					<select
						value={scene.camera}
						onChange={(event) => update({ camera: event.target.value })}
					>
						<option value="">指定なし</option>
						{cameras.map((camera) => (
							<option key={camera}>{camera}</option>
						))}
					</select>
				</label>
				<label htmlFor={`${id}-sound`}>
					音
					<Input
						id={`${id}-sound`}
						maxLength={2000}
						value={scene.sound}
						placeholder="波と風の音"
						onChange={(event) => update({ sound: event.target.value })}
					/>
				</label>
			</div>
			<div className="ds-video-prompt">
				<div className="ds-video-prompt-heading">
					<strong>動画作成プロンプト</strong>
					<span>{manual === undefined ? "選択内容と同期" : "手編集"}</span>
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={manual === undefined}
						onClick={() => {
							setManual(undefined);
							setReview(false);
						}}
					>
						選択内容を反映
					</Button>
				</div>
				{review && (
					<div className="ds-video-prompt-review">
						<output>
							選択内容が変わりました。手編集した文章を保持しています。
						</output>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => setReview(false)}
						>
							編集内容を使う
						</Button>
					</div>
				)}
				<Textarea
					aria-label="動画作成プロンプト"
					rows={4}
					maxLength={8192}
					value={prompt}
					placeholder="組み立てた文章を自由に編集できます"
					onChange={(event) => setManual(event.target.value)}
				/>
			</div>
			<div className="ds-video-settings">
				<label>
					サイズ
					<select
						value={size ? sizeKey(size) : ""}
						disabled={!options?.sizes.length}
						onChange={(event) => setSize(event.target.value)}
					>
						{!size && (
							<option value="">
								{options ? "選び直してください" : "未取得"}
							</option>
						)}
						{options?.sizes.map((value) => (
							<option key={sizeKey(value)} value={sizeKey(value)}>
								{sizeKey(value)}
							</option>
						))}
					</select>
				</label>
				<label>
					動画の長さ
					<select
						value={duration ?? ""}
						disabled={!options?.durations.length}
						onChange={(event) => setDuration(event.target.value)}
					>
						{duration === undefined && (
							<option value="">
								{options ? "選び直してください" : "未取得"}
							</option>
						)}
						{options?.durations.map((value) => (
							<option key={value} value={value}>
								{value}秒
							</option>
						))}
					</select>
				</label>
				<label htmlFor={`${id}-title`}>
					タイトル（任意）
					<Input id={`${id}-title`} name="title" maxLength={256} />
				</label>
				<label htmlFor={`${id}-seed`}>
					シード（任意）
					<Input
						id={`${id}-seed`}
						name="seed"
						type="number"
						min={0}
						max={2147483647}
						step={1}
						placeholder="42"
					/>
				</label>
			</div>
			<div className="ds-video-form-footer">
				<small title={model}>
					音声付きMP4 · 24fps · 4ステップ
					<br />
					生成の目安は約9分
				</small>
				<Button type="submit" disabled={!canSubmit}>
					動画を生成
				</Button>
			</div>
		</form>
	);
}
