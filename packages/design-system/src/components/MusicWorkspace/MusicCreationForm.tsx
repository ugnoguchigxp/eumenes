import { useId, useState } from "react";
import { Search, Sparkles, X } from "lucide-react";
import { Button } from "../Button";
import {
	emptyMusicSelection,
	musicSelectionText,
	musicSelectionInput,
	defaultMusicCreationOptions,
	type MusicCreationOptions,
	type MusicSelection,
	type MusicCreationInput,
	type MusicDurationModel,
} from "./music-creation-options";
import "./MusicCreationForm.css";

function Choices({
	label,
	options,
	selected,
	onChange,
}: {
	label: string;
	options: readonly string[];
	selected: string[];
	onChange: (next: string[]) => void;
}) {
	return (
		<fieldset className="music-creation-choices">
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
										: selected.filter((item) => item !== option),
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
function SelectChoice({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: string;
	options: readonly string[];
	onChange: (next: string) => void;
}) {
	return (
		<label className="music-creation-select">
			<span>{label}</span>
			<select value={value} onChange={(event) => onChange(event.target.value)}>
				{options.map((option) => (
					<option key={option}>{option}</option>
				))}
			</select>
		</label>
	);
}
function VocalChoices({
	selection,
	update,
	options,
}: {
	selection: MusicSelection;
	update: (next: MusicSelection) => void;
	options: MusicCreationOptions;
}) {
	return (
		<section className="music-creation-vocals">
			{selection.vocals ? (
				<>
					<div className="music-creation-selects">
						<SelectChoice
							label="ボーカル"
							value={selection.gender}
							options={options.vocalists}
							onChange={(gender) => update({ ...selection, gender })}
						/>
						<SelectChoice
							label="声の高さ"
							value={selection.range}
							options={options.ranges}
							onChange={(range) => update({ ...selection, range })}
						/>
						<SelectChoice
							label="歌い方"
							value={selection.singing}
							options={options.singingStyles}
							onChange={(singing) => update({ ...selection, singing })}
						/>
						<SelectChoice
							label="歌詞の言語"
							value={selection.language}
							options={options.languages}
							onChange={(language) => update({ ...selection, language })}
						/>
					</div>
					<Choices
						label="声質"
						options={options.voiceQualities}
						selected={selection.voiceQualities}
						onChange={(voiceQualities) =>
							update({ ...selection, voiceQualities })
						}
					/>
					<label className="music-creation-lyrics">
						歌詞（任意）
						<textarea
							value={selection.lyrics}
							maxLength={4000}
							rows={3}
							placeholder={
								"[Verse]\nここに歌詞を入力。空欄ならテーマから作ります。"
							}
							onChange={(event) =>
								update({ ...selection, lyrics: event.target.value })
							}
						/>
					</label>
					<p className="music-creation-hint">
						声の特徴は生成への希望として反映します。同じ歌手の声を固定する指定ではありません。
					</p>
				</>
			) : (
				<p className="music-creation-hint">インストゥルメンタル（歌声なし）</p>
			)}
		</section>
	);
}

function DurationChoice({
	selection,
	update,
	limits,
	valid: durationValid,
}: {
	selection: MusicSelection;
	update: (value: MusicSelection) => void;
	limits?: MusicDurationModel;
	valid: boolean;
}) {
	return (
		<label className="music-creation-select">
			<span>長さ</span>
			<input
				type="number"
				min={1}
				max={limits?.maxDurationSeconds}
				step="any"
				value={selection.duration}
				placeholder={
					limits?.defaultDurationSeconds
						? `${limits.defaultDurationSeconds}秒（おまかせ）`
						: "おまかせ"
				}
				onChange={(event) =>
					update({ ...selection, duration: event.target.value })
				}
			/>
			<small>
				{limits
					? `1〜${limits.maxDurationSeconds}秒／省略時${limits.defaultDurationSeconds ?? "おまかせ"}秒`
					: "用途別の長さは生成サービスで確認します"}
			</small>
			{!durationValid && (
				<span role="alert">
					長さを指定可能な範囲に直してください。自動では短縮しません。
				</span>
			)}
		</label>
	);
}

export type MusicCreationFormProps = {
	busy?: boolean;
	initialPrompt?: string;
	options?: MusicCreationOptions;
	models?: readonly MusicDurationModel[];
	onGenerate: (prompt: string, input?: MusicCreationInput) => void;
};
export function MusicCreationForm({
	busy,
	initialPrompt,
	options = defaultMusicCreationOptions,
	onGenerate,
	models,
}: MusicCreationFormProps) {
	const id = useId();

	const [selection, setSelection] = useState(() =>
		emptyMusicSelection(options),
	);
	const [prompt, setPrompt] = useState(
		() => initialPrompt ?? musicSelectionText(emptyMusicSelection(options)),
	);
	const [edited, setEdited] = useState(!!initialPrompt);
	const [pending, setPending] = useState(false);
	const [previous, setPrevious] = useState<string>();
	const [search, setSearch] = useState("");
	const update = (next: MusicSelection) => {
		setSelection(next);
		if (edited) setPending(true);
		else setPrompt(musicSelectionText(next));
	};
	const reflect = () => {
		setPrevious(prompt);
		setPrompt(musicSelectionText(selection));
		setEdited(false);
		setPending(false);
	};
	const reset = () => {
		setPrevious(prompt);
		setSelection(emptyMusicSelection(options));
		setPrompt(musicSelectionText(emptyMusicSelection(options)));
		setEdited(false);
		setPending(false);
		setSearch("");
	};
	const kind = selection.soundEffect
		? "sound-effect"
		: selection.vocals
			? "vocals"
			: "music";
	const limits = models?.find((m) => m.task === kind);
	const durationValid =
		!selection.duration ||
		(Number(selection.duration) >= 1 &&
			(limits === undefined ||
				Number(selection.duration) <= limits.maxDurationSeconds));
	const lengthValid =
		prompt.length + JSON.stringify(musicSelectionInput(selection)).length <=
		7600;
	const groups = options.genreGroups
		.map((group) => ({
			...group,
			options: group.options.filter((option) =>
				option.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
			),
		}))
		.filter((group) => group.options.length);
	return (
		<form
			className="music-creation-form"
			onSubmit={(event) => {
				event.preventDefault();
				if (
					!busy &&
					!pending &&
					durationValid &&
					lengthValid &&
					prompt.trim() &&
					prompt.length <= 7600
				)
					onGenerate(prompt.trim(), musicSelectionInput(selection));
			}}
		>
			<div className="music-creation-scroll">
				<header className="music-creation-heading">
					<h3>
						{selection.soundEffect
							? "どんな効果音にしますか？"
							: "どんな楽曲にしますか？"}
					</h3>
					<Button type="button" variant="ghost" size="sm" onClick={reset}>
						リセット
					</Button>
				</header>
				<label className="music-creation-select">
					<span>用途</span>
					<select
						value={kind}
						onChange={(event) =>
							update({
								...selection,
								soundEffect: event.target.value === "sound-effect",
								vocals: event.target.value === "vocals",
							})
						}
					>
						<option value="music">歌なし音楽</option>
						<option value="vocals">ボーカル</option>
						<option value="sound-effect">効果音</option>
					</select>
				</label>
				{!selection.soundEffect && (
					<Choices
						label="雰囲気"
						options={options.moods}
						selected={selection.moods}
						onChange={(moods) => update({ ...selection, moods })}
					/>
				)}
				{!selection.soundEffect && (
					<Choices
						label="楽器"
						options={options.instruments}
						selected={selection.instruments}
						onChange={(instruments) => update({ ...selection, instruments })}
					/>
				)}
				<div className="music-creation-selects">
					{!selection.soundEffect && (
						<SelectChoice
							label="テンポ"
							value={selection.tempo}
							options={options.tempos}
							onChange={(tempo) => update({ ...selection, tempo })}
						/>
					)}
					<DurationChoice
						selection={selection}
						update={update}
						limits={limits}
						valid={durationValid}
					/>
				</div>
				{!selection.soundEffect && (
					<>
						<div className="music-creation-genre-heading">
							<h4>
								ジャンル <small>複数選択できます</small>
							</h4>
							<label className="music-creation-search">
								<Search aria-hidden="true" />
								<input
									aria-label="ジャンルを探す"
									placeholder="ジャンルを探す"
									value={search}
									onChange={(event) => setSearch(event.target.value)}
								/>
							</label>
						</div>
						<div
							className="music-creation-genres"
							role="region"
							aria-label="ジャンル一覧"
							// oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- scrollable or keyboard-reachable region needs to take focus
							tabIndex={0}
						>
							{groups.map((group) => (
								<details key={group.label} open>
									<summary>{group.label}</summary>
									<Choices
										label={group.label}
										options={group.options}
										selected={selection.genres}
										onChange={(genres) => update({ ...selection, genres })}
									/>
								</details>
							))}
							{!groups.length && <p>該当するジャンルはありません。</p>}
						</div>
						{selection.genres.length > 0 && (
							<div
								className="music-creation-selected"
								aria-label="選択したジャンル"
							>
								{selection.genres.map((genre) => (
									<Button
										key={genre}
										type="button"
										size="sm"
										variant="secondary"
										aria-label={`${genre}を解除`}
										onClick={() =>
											update({
												...selection,
												genres: selection.genres.filter(
													(item) => item !== genre,
												),
											})
										}
									>
										{genre}
										<X aria-hidden="true" />
									</Button>
								))}
							</div>
						)}
						<VocalChoices
							selection={selection}
							update={update}
							options={options}
						/>
					</>
				)}
				{selection.soundEffect && (
					<p className="music-creation-hint">
						素材・動き・響きなどをプロンプトに書いてください。効果音には歌詞を送りません。
					</p>
				)}
			</div>
			<div className="music-creation-prompt">
				<div className="music-creation-prompt-heading">
					<label htmlFor={`${id}-prompt`}>音楽作成プロンプト</label>
					<span>{edited ? "編集中" : "選択内容と同期"}</span>
				</div>
				{pending && (
					<div className="music-creation-update" role="status">
						<p>
							手入力を保護しています。反映すると、下の文章を選択内容に置き換えます。
						</p>
						<details>
							<summary>選択内容の更新候補</summary>
							<pre>{musicSelectionText(selection)}</pre>
						</details>
						<Button type="button" size="sm" variant="outline" onClick={reflect}>
							選択内容を反映
						</Button>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={() => setPending(false)}
						>
							編集内容を使う
						</Button>
					</div>
				)}
				<textarea
					id={`${id}-prompt`}
					value={prompt}
					rows={5}
					maxLength={7600}
					placeholder="作りたい音楽のイメージを自由に書いてください"
					onChange={(event) => {
						setPrompt(event.target.value);
						setEdited(true);
					}}
				/>
				{!lengthValid && (
					<p role="alert">
						プロンプトと歌詞の合計が長すぎます。内容を短くしてください。
					</p>
				)}
				<div className="music-creation-actions">
					<span className="music-creation-hint">自由に編集できます</span>
					{previous !== undefined && (
						<Button
							type="button"
							size="sm"
							variant="ghost"
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
							busy ||
							pending ||
							!durationValid ||
							!lengthValid ||
							!prompt.trim() ||
							prompt.length > 7600
						}
					>
						<Sparkles aria-hidden="true" />
						{busy
							? "生成処理中"
							: selection.soundEffect
								? "効果音を生成"
								: "楽曲を生成"}
					</Button>
				</div>
			</div>
		</form>
	);
}
