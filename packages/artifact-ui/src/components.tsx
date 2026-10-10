import {
	Button,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	Input,
	Modal,
	RadioButtonGroup,
	Switch,
	Textarea,
} from "@eumenes/design-system";
import { Fragment, useId, useRef, useState } from "react";
import type {
	ArtifactEvent,
	ArtifactRequest,
	Field,
	FormResource,
	ImageResource,
	MemoryResource,
	QuestionResource,
	SettingsResource,
} from "./contracts";
import { imageDownloadName, isSafeImageUrl } from "./contracts";
import { useArtifactRuntime } from "./runtime";

function useAction(request: ArtifactRequest) {
	const runtime = useArtifactRuntime();
	const lock = useRef(false);
	const [pending, setPending] = useState(false);
	const [message, setMessage] = useState("");
	const source = request.source ?? `inline-${request.view}`;
	async function send(
		action: ArtifactEvent["action"],
		values: ArtifactEvent["values"],
	) {
		if (lock.current) return;
		lock.current = true;
		setPending(true);
		try {
			const receipt = await runtime.dispatch({
				id: crypto.randomUUID(),
				source,
				revision: runtime.snapshot[source]?.revision ?? 0,
				action,
				values,
			});
			setMessage(receipt.message);
		} catch {
			setMessage("操作に失敗しました。もう一度お試しください");
		} finally {
			lock.current = false;
			setPending(false);
		}
	}
	return {
		send,
		pending,
		message: pending ? "処理中です" : message,
		source,
		resource: runtime.snapshot[source],
	};
}
function Feedback({ message }: { message: string }) {
	return message ? (
		<output className="aui-feedback" aria-live="polite">
			{message}
		</output>
	) : null;
}
function Result({
	title,
	entries,
}: {
	title: string;
	entries: [string, string][];
}) {
	return (
		<section className="aui-result" aria-label={title}>
			<strong>{title}</strong>
			<dl>
				{entries.map(([label, value]) => (
					<Fragment key={label}>
						<dt>{label}</dt>
						<dd>{value}</dd>
					</Fragment>
				))}
			</dl>
		</section>
	);
}
export function ComponentsView({ request }: { request: ArtifactRequest }) {
	const action = useAction(request);
	const prefix = useId();
	const [example, setExample] = useState("");
	const data = action.resource;
	return (
		<Card>
			<CardHeader>
				<CardTitle>{request.title ?? "入力と操作の見本"}</CardTitle>
			</CardHeader>
			<CardContent>
				<div className="aui-stack">
					<p>入力した内容を受け取り、結果を下に表示します。</p>
					<label htmlFor={`${prefix}-example`}>
						入力の見本
						<Input
							id={`${prefix}-example`}
							placeholder="ここに入力できます"
							value={example}
							onChange={(event) => setExample(event.target.value)}
							maxLength={2000}
						/>
					</label>
					<div className="aui-row">
						<Button
							disabled={action.pending}
							onClick={() => void action.send("demo-click", { example })}
						>
							試す
						</Button>
						<Button variant="secondary" disabled>
							無効なボタン
						</Button>
					</div>
					<Feedback message={action.message} />
					{data?.kind === "components" && data.example !== undefined && (
						<Result
							title="受け取った内容"
							entries={[["入力", data.example || "（空欄）"]]}
						/>
					)}
				</div>
			</CardContent>
		</Card>
	);
}
export function ImageFrame({ request }: { request: ArtifactRequest }) {
	const { snapshot } = useArtifactRuntime();
	const resource = snapshot[request.source!] as ImageResource;
	// A URL outside the allowed schemes is treated as no image at all.
	const image: ImageResource = {
		...resource,
		url:
			resource.url && isSafeImageUrl(resource.url) ? resource.url : undefined,
	};
	const [open, setOpen] = useState(false);
	const [brokenUrl, setBrokenUrl] = useState<string>();
	const ready =
		image.status === "succeeded" && image.url && brokenUrl !== image.url;
	const status =
		brokenUrl === image.url && image.url
			? "画像を読み込めませんでした"
			: {
					queued: "生成を待っています",
					running: "画像を生成中です",
					succeeded: "画像が完成しました",
					failed: "画像生成に失敗しました",
					cancelled: "画像生成を取り消しました",
				}[image.status];
	return (
		<Card>
			<CardHeader>
				<CardTitle>{request.title ?? "生成した画像"}</CardTitle>
			</CardHeader>
			<CardContent>
				<figure className="aui-frame">
					{ready ? (
						<button
							type="button"
							className="aui-image-button"
							aria-label="画像を全画面で表示"
							onClick={() => setOpen(true)}
						>
							<img
								src={image.url}
								alt={image.alt}
								onError={() => setBrokenUrl(image.url)}
							/>
						</button>
					) : (
						<div
							className="aui-placeholder"
							aria-label="画像のプレースホルダー"
						>
							<span aria-hidden="true">◇</span>
							<span>{status}</span>
						</div>
					)}
					<figcaption>
						<output>{status}</output>
					</figcaption>
				</figure>
				{ready && (
					<a
						className="aui-download"
						href={image.url}
						download={imageDownloadName(image)}
					>
						画像をダウンロード
					</a>
				)}
				<Modal
					open={!!ready && open}
					onOpenChange={setOpen}
					title="生成画像の全画面表示"
					draggable={false}
					className="aui-fullscreen"
				>
					<img
						className="aui-fullscreen-image"
						src={image.url}
						alt={image.alt}
					/>
				</Modal>
			</CardContent>
		</Card>
	);
}
export function QuestionView({ request }: { request: ArtifactRequest }) {
	const action = useAction(request);
	const data = action.resource as QuestionResource;
	const [draft, setDraft] = useState({ identity: "", value: "" });
	const prefix = useId();
	const disabled = action.pending || data.status !== "open";
	const questionIdentity = JSON.stringify(data.question);
	const answer =
		data.status === "answered"
			? (data.answer ?? "")
			: draft.identity === questionIdentity
				? draft.value
				: "";
	const setAnswer = (value: string) =>
		setDraft({ identity: questionIdentity, value });
	return (
		<Card>
			<CardHeader>
				<CardTitle>{request.title ?? "少し教えてください"}</CardTitle>
			</CardHeader>
			<CardContent>
				<form
					className="aui-stack"
					onSubmit={(event) => {
						event.preventDefault();
						if (answer.trim() && !disabled)
							void action.send("answer", { answer: answer.trim() });
					}}
				>
					<p>{data.question.prompt}</p>
					{data.question.options ? (
						<RadioButtonGroup
							label="回答を1つ選択"
							options={data.question.options.map((option) => ({
								value: option,
								label: option,
							}))}
							value={answer}
							onValueChange={setAnswer}
							disabled={disabled}
							required
						/>
					) : (
						<label htmlFor={`${prefix}-answer`}>
							回答
							<Textarea
								id={`${prefix}-answer`}
								value={answer}
								onChange={(e) => setAnswer(e.target.value)}
								disabled={disabled}
								required
								maxLength={2000}
							/>
						</label>
					)}
					<Button type="submit" disabled={disabled || !answer.trim()}>
						回答する
					</Button>
					<Feedback
						message={
							data.status === "answered"
								? `回答済み: ${data.answer}`
								: data.status === "expired"
									? "この質問は期限切れです"
									: action.message
						}
					/>
				</form>
			</CardContent>
		</Card>
	);
}
function FieldInput({
	field,
	value,
	onChange,
	disabled,
	prefix,
}: {
	field: Field;
	value: string | boolean;
	onChange: (value: string | boolean) => void;
	disabled: boolean;
	prefix: string;
}) {
	const id = `${prefix}-${field.id}`;
	return (
		<label htmlFor={id} className="aui-field">
			{field.label}
			{field.required && "（必須）"}
			{field.type === "boolean" ? (
				<input
					id={id}
					type="checkbox"
					checked={value === true}
					onChange={(e) => onChange(e.target.checked)}
					disabled={disabled}
					required={field.required}
				/>
			) : field.type === "select" ? (
				<select
					id={id}
					value={String(value)}
					onChange={(e) => onChange(e.target.value)}
					disabled={disabled}
					required={field.required}
				>
					<option value="">選んでください</option>
					{field.options?.map((o) => (
						<option key={o}>{o}</option>
					))}
				</select>
			) : field.type === "textarea" ? (
				<Textarea
					id={id}
					value={String(value)}
					onChange={(e) => onChange(e.target.value)}
					disabled={disabled}
					required={field.required}
					maxLength={2000}
				/>
			) : (
				<Input
					id={id}
					type={field.type === "number" ? "number" : "text"}
					value={String(value)}
					onChange={(e) => onChange(e.target.value)}
					disabled={disabled}
					required={field.required}
					maxLength={2000}
				/>
			)}
		</label>
	);
}
export function SmallForm({ request }: { request: ArtifactRequest }) {
	const action = useAction(request);
	const data = action.resource as FormResource;
	const [values, setValues] = useState(data.defaults);
	const prefix = useId();
	return (
		<Card>
			<CardHeader>
				<CardTitle>{request.title ?? "希望を入力"}</CardTitle>
			</CardHeader>
			<CardContent>
				<form
					className="aui-stack"
					onSubmit={(e) => {
						e.preventDefault();
						if (!action.pending) void action.send("submit", values);
					}}
				>
					{data.fields.map((field) => (
						<FieldInput
							key={field.id}
							prefix={prefix}
							field={field}
							value={
								values[field.id] ?? (field.type === "boolean" ? false : "")
							}
							disabled={action.pending}
							onChange={(value) =>
								setValues((v) => ({ ...v, [field.id]: value }))
							}
						/>
					))}
					<div className="aui-row">
						<Button type="submit" disabled={action.pending}>
							{action.pending ? "送信中" : "フォームを送信"}
						</Button>
						<Button
							type="button"
							variant="secondary"
							disabled={action.pending}
							onClick={() => setValues(data.defaults)}
						>
							入力をリセット
						</Button>
					</div>
					<Feedback message={action.message} />
					{data.submitted && (
						<Result
							title="前回受け取った内容"
							entries={data.fields.map((field) => {
								const value = data.submitted![field.id];
								return [
									field.label,
									typeof value === "boolean"
										? value
											? "はい"
											: "いいえ"
										: value || "（未入力）",
								];
							})}
						/>
					)}
				</form>
			</CardContent>
		</Card>
	);
}
export function MemoryReview({ request }: { request: ArtifactRequest }) {
	const action = useAction(request);
	const data = action.resource as MemoryResource;
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [selections, setSelections] = useState<Record<string, boolean>>({});
	const prefix = useId();
	return (
		<Card>
			<CardHeader>
				<CardTitle>{request.title ?? "覚えている情報を確認"}</CardTitle>
			</CardHeader>
			<CardContent>
				<div className="aui-stack">
					<p>
						この画面だけの試用データです。選択・訂正した結果をここで確認できます。
					</p>
					{data.entries.map((entry) => (
						<div className="aui-stack aui-memory-entry" key={entry.id}>
							<label className="aui-row">
								<input
									type="checkbox"
									checked={selections[entry.id] ?? entry.selected}
									disabled={action.pending}
									onChange={(e) => {
										setSelections((values) => ({
											...values,
											[entry.id]: e.target.checked,
										}));
										void action
											.send("memory-select", {
												id: entry.id,
												selected: e.target.checked,
											})
											.finally(() =>
												setSelections((values) => {
													const next = { ...values };
													delete next[entry.id];
													return next;
												}),
											);
									}}
								/>
								利用候補に選ぶ: {entry.text}
							</label>
							<label htmlFor={`${prefix}-${entry.id}`}>
								メモリーの内容
								<Textarea
									id={`${prefix}-${entry.id}`}
									aria-label="メモリーの内容"
									value={drafts[entry.id] ?? entry.text}
									maxLength={2000}
									onChange={(e) =>
										setDrafts((v) => ({ ...v, [entry.id]: e.target.value }))
									}
								/>
							</label>
							<Button
								disabled={
									action.pending || !(drafts[entry.id] ?? entry.text).trim()
								}
								onClick={() =>
									void action.send("memory-correct", {
										id: entry.id,
										text: (drafts[entry.id] ?? entry.text).trim(),
									})
								}
							>
								訂正を反映
							</Button>
							<Result
								title="試用データの現在値"
								entries={[
									["内容", entry.text],
									["選択", entry.selected ? "選択済み" : "未選択"],
								]}
							/>
						</div>
					))}
					<Feedback message={action.message} />
				</div>
			</CardContent>
		</Card>
	);
}
export function SettingsForm({ request }: { request: ArtifactRequest }) {
	const runtime = useArtifactRuntime();
	const action = useAction(request);
	const data = action.resource as SettingsResource;
	const [values, setValues] = useState({
		theme: data.theme,
		autoSpeak: data.autoSpeak,
		volume: String(data.volume),
	});
	const prefix = useId();
	const theme = runtime.previewTheme ?? values.theme;
	return (
		<Card
			className={`aui-settings-theme ${runtime.previewTheme === undefined ? `ds-theme-${theme}` : ""}`}
			data-theme={theme}
		>
			<CardHeader>
				<CardTitle>{request.title ?? "表示と音声"}</CardTitle>
			</CardHeader>
			<CardContent>
				<form
					className="aui-stack"
					onSubmit={(e) => {
						e.preventDefault();
						void action.send("settings-save", { ...values, theme });
					}}
				>
					<p>
						テーマはこのプレビューに反映します。保存先は試用データです。
						音声再生やアプリの設定は変更しません。
					</p>
					{runtime.previewTheme === undefined && (
						<label>
							表示テーマ
							<select
								aria-label="表示テーマ"
								value={values.theme}
								onChange={(e) =>
									setValues((v) => ({
										...v,
										theme: e.target.value as "light" | "dark",
									}))
								}
								disabled={action.pending}
							>
								<option value="light">ライト</option>
								<option value="dark">ダーク</option>
							</select>
						</label>
					)}
					<label className="aui-row" htmlFor={`${prefix}-speak`}>
						回答を読み上げる
						<Switch
							id={`${prefix}-speak`}
							checked={values.autoSpeak}
							onCheckedChange={(autoSpeak) =>
								setValues((v) => ({ ...v, autoSpeak }))
							}
							disabled={action.pending}
						/>
					</label>
					<label htmlFor={`${prefix}-volume`}>
						音量: {values.volume}
						<input
							id={`${prefix}-volume`}
							type="range"
							min="0"
							max="100"
							value={values.volume}
							onChange={(e) =>
								setValues((v) => ({ ...v, volume: e.target.value }))
							}
							disabled={action.pending}
						/>
					</label>
					<Button type="submit" disabled={action.pending}>
						設定を保存
					</Button>
					<Feedback message={action.message} />
					<Result
						title="試用データの現在値"
						entries={[
							["保存済みのテーマ", data.theme === "dark" ? "ダーク" : "ライト"],
							["読み上げ", data.autoSpeak ? "オン" : "オフ"],
							["音量", String(data.volume)],
						]}
					/>
				</form>
			</CardContent>
		</Card>
	);
}
