import { useMemo, useState } from "react";
import { Button } from "../Button";
import type {
	PipelineSourceDiff,
	PipelineStudioIssue,
	PipelineStudioWorkData,
} from "./types";

type Props = {
	work: PipelineStudioWorkData;
	diff: PipelineSourceDiff | null;
	/** A host action is in flight. */
	pending: boolean;
	/** The last receipt: a refused apply is shown beside the editor. */
	result: { status: string; message: string };
	/** Resolves true when the host accepted the text. */
	onApply: (text: string, revision: number) => Promise<boolean> | void;
};

/** The failed whole draft of the specialist: read-only, never used as the draft. */
function RejectedDraft({
	rejected,
	canLoad,
	onLoad,
}: {
	rejected: NonNullable<PipelineStudioWorkData["rejected"]>;
	canLoad: boolean;
	onLoad: () => void;
}) {
	return (
		<section
			className="pipeline-studio-rejected"
			aria-label="反映できなかった案"
		>
			<div className="pipeline-studio-rejected-head">
				<strong>形式の検査を通りませんでした</strong>
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
				書かれた次の案は形式の検査を通らなかったため、下書きには反映していません。直して、もう一度反映してください。
				{rejected.title ? `（${rejected.title}）` : ""}
			</p>
			{rejected.issues.length > 0 && (
				<ul aria-label="形式の指摘">
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
						<li key={`${index}:${fix}`}>{fix}</li>
					))}
				</ul>
			)}
			<pre className="pipeline-studio-code">
				<code>{rejected.text}</code>
			</pre>
		</section>
	);
}

const lineSet = (issues: PipelineStudioIssue[]) =>
	new Set(
		issues.flatMap((issue) => (issue.line === null ? [] : [issue.line - 1])),
	);

/**
 * The canonical JSON text of the draft, with the lines the last change touched and the lines the check
 * names marked. The text can be edited and applied as the draft's next revision.
 */
export function PipelineSource({
	work,
	diff,
	pending,
	result,
	onApply,
}: Props) {
	// The text being edited and the revision it was taken from: a moved draft asks to start over.
	const [edit, setEdit] = useState<{ text: string; base: number } | null>(null);
	const [attempted, setAttempted] = useState(false);
	const lines = useMemo(
		() => (work.source === "" ? [] : work.source.split("\n")),
		[work.source],
	);
	const flagged = useMemo(() => lineSet(work.issues), [work.issues]);
	const removedBefore = useMemo(
		() => new Map((diff?.removed ?? []).map((item) => [item.at, item.lines])),
		[diff],
	);
	const changedCount = diff?.changed.filter(Boolean).length ?? 0;
	const removedCount = (diff?.removed ?? []).reduce(
		(sum, item) => sum + item.lines.length,
		0,
	);
	const blocked = work.busy || pending;
	const stale = !!edit && edit.base !== work.revision;
	const unchanged = !!edit && edit.text === work.source;
	const refusal =
		attempted && (result.status === "rejected" || result.status === "conflict")
			? result.message
			: "";
	const load = (text: string) => {
		setAttempted(false);
		setEdit({ text, base: work.revision });
	};
	const stop = () => {
		setEdit(null);
		setAttempted(false);
	};
	return (
		<div className="pipeline-studio-source">
			<div className="pipeline-studio-source-head">
				<span>
					<strong>編集中</strong> ・ revision {work.revision}
				</span>
				<span className="pipeline-studio-actions">
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
									void Promise.resolve(onApply(edit.text, edit.base)).then(
										(ok) => {
											if (ok === false) return;
											stop();
										},
									);
								}}
							>
								この内容を反映
							</Button>
							<Button type="button" variant="outline" size="sm" onClick={stop}>
								編集をやめる
							</Button>
						</>
					) : (
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={blocked}
							onClick={() => load(work.source)}
						>
							編集
						</Button>
					)}
				</span>
			</div>
			{!edit && (changedCount > 0 || removedCount > 0) && (
				<div className="pipeline-studio-diff">
					<p>
						<strong>直前の変更</strong> ・ {changedCount}行を追加・変更
						{removedCount > 0 ? `、${removedCount}行を削除` : ""}
					</p>
					{removedCount > 0 && (
						<details>
							<summary>削除された行</summary>
							<pre className="pipeline-studio-code">
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
				<output className="pipeline-studio-warning">
					編集を始めたあとに下書きが更新されました。編集をやめて、最新の内容から編集し直してください。
				</output>
			)}
			{edit ? (
				<textarea
					className="pipeline-studio-editor"
					aria-label="パイプライン定義JSONの編集"
					spellCheck={false}
					rows={Math.min(30, Math.max(8, edit.text.split("\n").length + 1))}
					value={edit.text}
					onChange={(event) => {
						setAttempted(false);
						setEdit({ text: event.target.value, base: edit.base });
					}}
				/>
			) : lines.length > 0 ? (
				<section
					className="pipeline-studio-frame"
					aria-label="パイプライン定義JSON"
				>
					{/* Line numbers sit in their own gutter so selecting the code never copies them. */}
					<div className="pipeline-studio-gutter" aria-hidden="true">
						{lines.map((_, index) => (
							<span
								// biome-ignore lint/suspicious/noArrayIndexKey: the gutter is positional
								key={index}
								data-change={diff?.changed[index] ? "changed" : undefined}
								data-removed={removedBefore.has(index) ? "true" : undefined}
								data-issue={flagged.has(index) ? "true" : undefined}
							>
								{index + 1}
							</span>
						))}
					</div>
					<pre className="pipeline-studio-code">
						<code>
							{lines.map((line, index) => (
								<span
									// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
									key={index}
									className="pipeline-studio-line-text"
									data-change={diff?.changed[index] ? "changed" : undefined}
									data-issue={flagged.has(index) ? "true" : undefined}
								>
									{line}
									{index < lines.length - 1 ? "\n" : ""}
								</span>
							))}
						</code>
					</pre>
				</section>
			) : (
				<p className="pipeline-studio-note">まだ反映された定義がありません。</p>
			)}
			{refusal && (
				<div className="pipeline-studio-refusal" role="alert">
					{refusal}
				</div>
			)}
			{work.rejected && (
				<RejectedDraft
					rejected={work.rejected}
					canLoad={!blocked}
					onLoad={() => work.rejected && load(work.rejected.text)}
				/>
			)}
		</div>
	);
}
