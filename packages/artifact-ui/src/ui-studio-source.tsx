import { Button } from "@eumenes/design-system";
import { useMemo, useState } from "react";
import type { UiStudioResource } from "./contracts";
import { tokenizeJsonLines } from "./json-tokens";
import { diffLines } from "./ui-studio-diff";

export type StudioWork = NonNullable<UiStudioResource["work"]>;

/** The last whole draft the specialist wrote that failed the check: read-only, never previewed. */
function RejectedDraft({
	rejected,
	canLoad,
	onLoad,
}: {
	rejected: NonNullable<StudioWork["rejected"]>;
	canLoad: boolean;
	onLoad: () => void;
}) {
	return (
		<section className="aui-ui-rejected" aria-label="反映できなかった案">
			<div className="aui-ui-rejected-head">
				<strong>反映できなかった案</strong>
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={!canLoad}
					onClick={onLoad}
				>
					エディタに読み込む
				</Button>
			</div>
			<p>
				専門担当が書いた次の案は検査を通らなかったため、プレビューには反映していません。
				{rejected.title ? `（${rejected.title}）` : ""}
			</p>
			{rejected.issues.length > 0 && (
				<ul aria-label="検査の指摘">
					{rejected.issues.map((issue, index) => (
						<li key={`${index}:${issue.path}:${issue.rule}`}>
							<code>
								{issue.path}: {issue.rule}
							</code>
						</li>
					))}
				</ul>
			)}
			{rejected.fixes.length > 0 && (
				<ul aria-label="自動で補正した内容">
					{rejected.fixes.map((fix, index) => (
						// The same fix code can repeat (one per place): the position keeps keys unique.
						<li key={`${index}:${fix}`}>{fix}</li>
					))}
				</ul>
			)}
			<pre className="aui-ui-rejected-text">
				<code>{rejected.text}</code>
			</pre>
		</section>
	);
}

/**
 * The canonical text of the definition the preview shows, with the lines the last change touched
 * marked. A draft can be edited here and applied as the work's next revision.
 */
export function StudioSource({
	text,
	previousText,
	label,
	revision,
	work,
	pending,
	result,
	onApply,
}: {
	text: string;
	previousText: string | null;
	label: string;
	revision: number;
	work: StudioWork | null;
	pending: boolean;
	result: { status: string; message: string };
	onApply: (text: string, revision: number) => Promise<boolean>;
}) {
	const [copied, setCopied] = useState<"done" | "failed" | null>(null);
	// The text being edited and the revision it was taken from: a moved work asks to start over.
	const [edit, setEdit] = useState<{ text: string; base: number } | null>(null);
	const [attempted, setAttempted] = useState(false);
	const lines = useMemo(() => tokenizeJsonLines(text), [text]);
	const diff = useMemo(
		() => (previousText === null ? null : diffLines(previousText, text)),
		[previousText, text],
	);
	const removedBefore = useMemo(
		() => new Map((diff?.removed ?? []).map((item) => [item.at, item.lines])),
		[diff],
	);
	const changedCount = diff?.changed.filter(Boolean).length ?? 0;
	const removedCount = (diff?.removed ?? []).reduce(
		(sum, item) => sum + item.lines.length,
		0,
	);
	const blocked = !work || work.busy || pending;
	const stale = !!edit && !!work && edit.base !== work.revision;
	const unchanged = !!edit && edit.text === text;
	const refusal =
		attempted && (result.status === "rejected" || result.status === "conflict")
			? result.message
			: "";
	const load = (value: string) => {
		if (!work) return;
		setAttempted(false);
		setEdit({ text: value, base: work.revision });
	};
	return (
		<div className="aui-ui-source">
			<div className="aui-ui-source-head">
				<span>
					<strong>{label}</strong> ・ revision {revision}
				</span>
				<span className="aui-ui-source-actions">
					{edit ? (
						<>
							<Button
								type="button"
								size="sm"
								disabled={
									blocked || stale || unchanged || edit.text.trim() === ""
								}
								onClick={() => {
									setAttempted(true);
									void onApply(edit.text, edit.base).then((ok) => {
										if (!ok) return;
										setEdit(null);
										setAttempted(false);
									});
								}}
							>
								この内容を反映
							</Button>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => {
									setEdit(null);
									setAttempted(false);
								}}
							>
								編集をやめる
							</Button>
						</>
					) : (
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={blocked}
							title={work ? undefined : "保存した作品はここでは編集できません"}
							onClick={() => load(text)}
						>
							編集
						</Button>
					)}
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => {
							navigator.clipboard
								.writeText(edit?.text ?? text)
								.then(() => setCopied("done"))
								.catch(() => setCopied("failed"));
						}}
					>
						コピー
					</Button>
				</span>
			</div>
			{!edit && (changedCount > 0 || removedCount > 0) && (
				<div className="aui-ui-source-diff">
					<p>
						<strong>直前の変更</strong> ・ {changedCount}行を追加・変更
						{removedCount > 0 ? `、${removedCount}行を削除` : ""}
					</p>
					{removedCount > 0 && (
						<details>
							<summary>削除された行</summary>
							<pre>
								<code>
									{(diff?.removed ?? [])
										.map((item) => item.lines.join("\n"))
										.join("\n")}
								</code>
							</pre>
						</details>
					)}
				</div>
			)}
			{stale && (
				<output className="aui-feedback">
					編集を始めたあとに作品が更新されました。編集をやめて、最新の内容から編集し直してください。
				</output>
			)}
			{edit ? (
				<textarea
					className="aui-ui-source-editor"
					aria-label="OpenUI設定JSONの編集"
					spellCheck={false}
					rows={Math.min(30, Math.max(8, edit.text.split("\n").length + 1))}
					value={edit.text}
					onChange={(event) => {
						setAttempted(false);
						setEdit({ text: event.target.value, base: edit.base });
					}}
				/>
			) : lines.length > 0 && text !== "" ? (
				<section className="aui-ui-source-frame" aria-label="OpenUI設定JSON">
					{/* Line numbers sit in their own gutter so selecting the code never copies them. */}
					<div className="aui-ui-source-gutter" aria-hidden="true">
						{lines.map((_, index) => (
							<span
								// biome-ignore lint/suspicious/noArrayIndexKey: the gutter is positional
								key={index}
								data-change={diff?.changed[index] ? "changed" : undefined}
								data-removed={removedBefore.has(index) ? "true" : undefined}
							>
								{index + 1}
							</span>
						))}
					</div>
					<pre className="aui-ui-source-code">
						<code>
							{lines.map((tokens, index) => (
								<span
									// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
									key={index}
									className="aui-ui-source-line"
									data-change={diff?.changed[index] ? "changed" : undefined}
								>
									{tokens.map((token, at) => (
										<span
											// biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional
											key={at}
											className={`aui-json-${token.type}`}
										>
											{token.text}
										</span>
									))}
									{index < lines.length - 1 ? "\n" : ""}
								</span>
							))}
						</code>
					</pre>
				</section>
			) : (
				<p className="aui-ui-source-empty">まだ反映された定義がありません。</p>
			)}
			{refusal && (
				<div className="aui-ui-source-refusal" role="alert">
					{refusal}
				</div>
			)}
			{work?.rejected && (
				<RejectedDraft
					rejected={work.rejected}
					canLoad={!blocked}
					onLoad={() => work.rejected && load(work.rejected.text)}
				/>
			)}
			{copied && (
				<output className="aui-feedback">
					{copied === "done" ? "コピーしました" : "コピーできませんでした"}
				</output>
			)}
		</div>
	);
}
