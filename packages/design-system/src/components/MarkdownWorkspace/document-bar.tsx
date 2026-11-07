import type { MarkdownCurrent, MarkdownWorkspaceProps } from "./types";
import { SaveIconButton } from "../ActionButton";
import type { MarkdownCacheState } from "./use-cache-autosave";
export function MarkdownDocumentBar(
	props: MarkdownWorkspaceProps & {
		current: MarkdownCurrent;
		title: string;
		composing: boolean;
		conflict: boolean;
		dirty: boolean;
		cacheState?: MarkdownCacheState;
		onTitle(value: string): void;
		onCommit(save: boolean): Promise<void>;
	},
) {
	const state = props.current.saveState;
	const valid =
		props.title.length > 0 &&
		new TextEncoder().encode(props.title).length <= 4096;
	const disabled = props.pending || props.composing || props.conflict || !valid;
	const label =
		props.conflict || state === "conflict"
			? "更新の競合あり"
			: state === "unknown"
				? "保存結果不明（確認が必要）"
				: state === "saving"
					? "Doclingに保存中…"
					: props.dirty || props.current.dirty
						? "未保存（作業用下書き）"
						: "Doclingに保存済み";
	return (
		<div className="ds-markdown-documentbar">
			<input
				aria-label="文書名"
				maxLength={4096}
				value={props.title}
				onChange={(e) => props.onTitle(e.target.value)}
			/>
			<div className="ds-markdown-save-status">
				<span aria-live="polite">
					{props.composing ? "日本語入力中" : label}
					{props.dirty && ["saving", "unknown", "conflict"].includes(state)
						? "・入力中の変更あり"
						: ""}
				</span>
				{props.cacheAvailable && (
					<small
						aria-live="polite"
						data-state={props.cacheState}
						title="SSDの一時ファイルです。再起動や容量整理で消えるため、残す文書は保存アイコンからDoclingへ保存してください。"
					>
						{props.cacheState === "saved"
							? "cacheに一時保存済み"
							: props.cacheState === "saving"
								? "cacheに一時保存中…"
								: props.cacheState === "error"
									? "cacheへの一時保存に失敗（入力は保持）"
									: "cacheへの自動保存待ち"}
					</small>
				)}
			</div>
			{props.sessionState === "active" && (
				<button
					disabled={disabled || !props.dirty}
					onClick={() => void props.onCommit(false)}
				>
					共同編集に反映
				</button>
			)}
			<SaveIconButton
				label="Doclingに保存"
				title="Doclingに保存"
				loading={state === "saving"}
				disabled={
					disabled ||
					!props.archiveAvailable ||
					["saving", "unknown", "conflict"].includes(state)
				}
				onClick={() => void props.onCommit(true)}
			/>
		</div>
	);
}
