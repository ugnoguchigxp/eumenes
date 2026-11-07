import type { MarkdownCurrent, MarkdownWorkspaceProps } from "./types";

const errorMessage = (code: string) => {
	if (code === "markdown_payload_too_large")
		return "文書か復元情報の容量が保存先の上限を超えています。";
	if (["markdown_unauthorized", "markdown_forbidden"].includes(code))
		return "保存先への接続権限を確認してください。";
	if (code === "markdown_path_exists")
		return "同じ保存先の文書が既にあります。";
	if (code === "markdown_namespace_unavailable")
		return "保存領域が利用できません。";
	return "保存を受け付けられませんでした。";
};
export function MarkdownSaveNotice(
	props: MarkdownWorkspaceProps & {
		current: MarkdownCurrent;
		composing: boolean;
		onKeep(): Promise<void>;
		onLoad(): Promise<void>;
	},
) {
	const { current } = props;
	return (
		<>
			{current.saveState === "conflict" && current.conflict && (
				<div className="ds-markdown-notice" role="alert">
					<p>Docling側で文書が変更されています。手元の編集は保持しています。</p>
					<details>
						<summary>Doclingの最新版: {current.conflict.entry.title}</summary>
						<pre>{current.conflict.markdown}</pre>
					</details>
					<button
						disabled={props.pending || props.composing || !props.onResolve}
						onClick={() => {
							if (
								window.confirm(
									"表示した最新版を保存の基準にします。手元の編集を残し、次の保存で反映しますか？",
								)
							)
								void props.onKeep();
						}}
					>
						手元の編集を使う
					</button>
					<button
						disabled={props.pending || props.composing || !props.onReload}
						onClick={() => {
							if (
								window.confirm(
									"手元の変更を破棄して、Doclingの最新版を読み込みますか？",
								)
							)
								void props.onLoad();
						}}
					>
						Doclingの最新版を使う
					</button>
				</div>
			)}
			{current.saveError && (
				<div className="ds-markdown-notice" role="alert">
					{current.saveState === "unknown"
						? "保存結果はまだ不明です。同じ文書を読み直して確認します。"
						: current.saveState === "conflict"
							? "Doclingの最新版と手元の編集を確認して選んでください。"
							: errorMessage(current.saveError)}{" "}
					作業用下書きは保持しています。
					{["unknown", "conflict"].includes(current.saveState) && (
						<button
							disabled={props.pending}
							onClick={() => props.onReconcile(current.id)}
						>
							保存状態を確認
						</button>
					)}
				</div>
			)}
		</>
	);
}
