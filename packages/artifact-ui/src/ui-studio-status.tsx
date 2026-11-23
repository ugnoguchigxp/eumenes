import {
	Button,
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@eumenes/design-system";
import { History, Play, Sparkles, Square } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { ArtifactEvent } from "./contracts";
import { type UiStudioResource } from "./contracts";

const workflowFailures: Record<string, string> = {
	workflow_web_upgrade_required:
		"取得元を確認する仕組みが更新されています。会話でこのアプリの改訂を依頼してください。",
	workflow_web_evidence_invalid:
		"取得結果の出典を確認できませんでした。もう一度更新してください。",
	workflow_web_extraction_incomplete:
		"対象の情報を確認できませんでした。日付や取得先を確認して、もう一度更新してください。",
};
export const workflowFailureText = (code: string) =>
	workflowFailures[code] ?? code;

/** A small disclosure: a button that reveals a panel; Escape or an outside click closes it. */
function Disclosure({
	label,
	icon,
	children,
}: {
	label: string;
	icon: ReactNode;
	children: (close: () => void) => ReactNode;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button type="button" variant="outline" size="sm">
					{icon}
					{label}
				</Button>
			</PopoverTrigger>
			<PopoverContent
				className="aui-ui-disclosure-panel"
				aria-label={label}
				align="start"
				collisionPadding={8}
			>
				{children(() => setOpen(false))}
			</PopoverContent>
		</Popover>
	);
}

function expiryLabel(expiresAt: string) {
	const date = new Date(expiresAt);
	return Number.isNaN(date.getTime())
		? ""
		: date.toLocaleString("ja-JP", {
				month: "numeric",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			});
}

export function HistoryMenu({
	history,
	viewingId,
	onPick,
}: {
	history: UiStudioResource["history"];
	viewingId: string | undefined;
	/** Choosing a saved work (the studio asks first when that would drop unsaved work). */
	onPick: (item: UiStudioResource["history"][number]) => void;
}) {
	return (
		<Disclosure
			label="作品履歴"
			icon={<History size={14} aria-hidden="true" />}
		>
			{(close) => (
				<fieldset className="aui-ui-menu" aria-label="保存した作品">
					{history.length ? (
						history.map((item) => (
							<button
								key={item.id}
								type="button"
								className="aui-ui-menu-item"
								aria-current={viewingId === item.id ? "true" : undefined}
								onClick={() => {
									onPick(item);
									close();
								}}
							>
								{item.title || "名称未設定"}
								{item.storageState === "deleting"
									? "（削除待ち）"
									: item.storageState === "initializing"
										? "（保存先の準備中）"
										: ""}
							</button>
						))
					) : (
						<p className="aui-ui-menu-empty">保存した作品はまだありません。</p>
					)}
				</fieldset>
			)}
		</Disclosure>
	);
}

/** Progress and notices for the draft currently shown. */
export function StudioNotices({
	data,
	pending,
	send,
}: {
	data: UiStudioResource;
	pending: boolean;
	send: Send;
}) {
	const { work, session } = data;
	const suspended = session?.state === "suspended";
	const expiry = session ? expiryLabel(session.expiresAt) : "";
	return (
		<>
			{work?.busy && (
				<div className="aui-ui-progress">
					<output aria-live="polite">
						<Sparkles size={14} aria-hidden="true" />{" "}
						制作しています。完成すると反映されます。
					</output>
					{data.stoppable && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={pending}
							onClick={() => send("ui-stop")}
						>
							<Square size={14} aria-hidden="true" />
							停止
						</Button>
					)}
				</div>
			)}
			{work?.dirty && (
				<p
					className="aui-ui-notice"
					data-state={suspended ? "suspended" : undefined}
				>
					{suspended && (
						<strong>未保存・一時保留{expiry ? `（${expiry}まで）` : ""}</strong>
					)}
					<span>
						保存ボタンを押すまで作品には保存されません。サーバーの再起動や期限切れで破棄されます。
					</span>
					{suspended && (
						<Button
							type="button"
							size="sm"
							disabled={pending}
							onClick={() => send("ui-resume")}
						>
							<Play size={14} aria-hidden="true" />
							編集を再開
						</Button>
					)}
				</p>
			)}
		</>
	);
}

type Send = (
	event: ArtifactEvent["action"],
	values?: ArtifactEvent["values"],
) => void;

/** Only the app currently displayed can expose its failed save ticket. */
export function StorageProgress({
	viewing,
	work,
	pending,
	send,
	actionPending,
}: Pick<UiStudioResource, "viewing" | "work"> & {
	pending: boolean;
	actionPending: boolean;
	send: Send;
}) {
	const shown = viewing ?? work;
	const retry = shown?.retrySave;
	const reopen = shown?.reopenSave;
	if (retry || reopen)
		return (
			<div className="aui-ui-notice">
				<p>
					{shown?.storageReopening
						? "下書きに戻せませんでした。もう一度お試しください。"
						: reopen
							? "保存先の準備に失敗しました。原因を解消して再試行するか、下書きに戻して修正できます。"
							: "保存先の準備に失敗しました。原因を解消した後、同じ内容の保存を再開できます。"}
				</p>
				{retry && (
					<Button
						size="sm"
						disabled={actionPending}
						onClick={() =>
							send("ui-retry-save", {
								...retry,
								stateRevision: String(retry.stateRevision),
							})
						}
					>
						保存を再試行
					</Button>
				)}
				{reopen && (
					<Button
						size="sm"
						variant="outline"
						disabled={actionPending}
						onClick={() =>
							send("ui-reopen-save", {
								...reopen,
								stateRevision: String(reopen.stateRevision),
							})
						}
					>
						下書きに戻す
					</Button>
				)}
			</div>
		);
	if (
		(!!viewing || !pending) &&
		shown?.storageState !== "initializing" &&
		shown?.storageState !== "deleting"
	)
		return null;
	return (
		<output className="aui-ui-notice">
			{shown?.storageReopening
				? "下書きに戻しています。"
				: shown?.storageState === "deleting"
					? "アプリの削除待ち"
					: "アプリの保存先を準備しています。"}
			{shown?.storageError ? `（${shown.storageError}）` : ""}
		</output>
	);
}
