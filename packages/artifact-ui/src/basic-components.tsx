import {
	Button,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	Input,
	Modal,
	RadioButtonGroup,
	Textarea,
} from "@eumenes/design-system";
import { useId, useState } from "react";
import { Feedback, useAction } from "./action";
import type {
	ArtifactRequest,
	ImageResource,
	MemoryResource,
	QuestionResource,
} from "./contracts";
import { imageDownloadName, isSafeImageUrl } from "./contracts";
import { Result } from "./result";
import { useArtifactRuntime } from "./runtime";
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
		!image.url && image.emptyMessage
			? image.emptyMessage
			: brokenUrl === image.url && image.url
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
