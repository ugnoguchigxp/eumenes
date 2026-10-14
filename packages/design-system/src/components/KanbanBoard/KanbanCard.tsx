import { Check, GripVertical, OctagonAlert, TriangleAlert } from "lucide-react";
import {
	type DragEvent,
	type KeyboardEvent,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { Button, type ButtonProps } from "../Button";
import { NoteForm, TaskForm } from "./CardForms";
import { CommitPushDialog } from "./CommitPushDialog";
import { MoveMenu } from "./MoveMenu";
import { type MovableColumn, othersIn } from "./positions";
import type {
	KanbanBoardCard,
	KanbanBoardProps,
	KanbanCardAction,
} from "./types";

type Panel = "edit" | "followup" | "move" | "remove" | null;
type Act = Exclude<KanbanCardAction, "edit">;

const ACTION_ORDER: readonly KanbanCardAction[] = [
	"run",
	"followup",
	"commitPush",
	"review",
	"cancel",
	"stop",
	"open",
	"reset",
	"edit",
	"remove",
];
/** Actions that start a Claude Code run; they need run tracking. */
const NEEDS_RUN: ReadonlySet<KanbanCardAction> = new Set([
	"run",
	"followup",
	"commitPush",
]);
/** Button truncates long labels; action wording is shown in full. */
const LABEL_MAX = 40;
const VARIANT: Partial<Record<KanbanCardAction, ButtonProps["variant"]>> = {
	run: "default",
	commitPush: "default",
	stop: "outline-destructive",
	remove: "outline-destructive",
};

function actionLabel(action: KanbanCardAction, card: KanbanBoardCard) {
	switch (action) {
		case "run":
			return card.column === "todo" ? "実行" : "やり直す";
		case "followup":
			return "追加で直す";
		case "commitPush":
			return "commit & push";
		case "review":
			return "確認済みにする";
		case "cancel":
			return "取消";
		case "stop":
			return "止めて Blocker にする";
		case "open":
			return "Claude Code を開く";
		case "reset":
			return "未着手へ戻す";
		case "edit":
			return "編集";
		case "remove":
			return "削除";
	}
}

const stamp = new Intl.DateTimeFormat("ja-JP", {
	month: "numeric",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
});
function updatedText(iso: string) {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? "" : stamp.format(date);
}

export type KanbanCardProps = {
	card: KanbanBoardCard;
	cards: readonly KanbanBoardCard[];
	runnable: boolean;
	busy: boolean;
	dragging: boolean;
	onEdit: KanbanBoardProps["onEdit"];
	onMove: KanbanBoardProps["onMove"];
	onAction: KanbanBoardProps["onAction"];
	onDragStart: (cardId: string, event: DragEvent<HTMLElement>) => void;
	onDragEnd: () => void;
	/** The card will change place or column: take focus back when the host redraws it. */
	keepFocus: (cardId: string) => void;
};

export function KanbanCard({
	card,
	cards,
	runnable,
	busy,
	dragging,
	onEdit,
	onMove,
	onAction,
	onDragStart,
	onDragEnd,
	keepFocus,
}: KanbanCardProps) {
	const titleId = useId();
	const detailId = useId();
	const [panel, setPanel] = useState<Panel>(null);
	const [expanded, setExpanded] = useState(false);
	// The card as the person saw it when the dialog opened (what they confirm is this revision).
	const [confirming, setConfirming] = useState<KanbanBoardCard | null>(null);
	const article = useRef<HTMLElement>(null);
	const opener = useRef<Element | null>(null);
	const afterClose = useRef<"trigger" | "card" | null>(null);

	// Returns focus once a panel is gone: to its button when cancelled, to the card when done.
	useEffect(() => {
		if (panel !== null || afterClose.current === null) return;
		const trigger = opener.current;
		const target =
			afterClose.current === "trigger" && trigger?.isConnected
				? (trigger as HTMLElement)
				: article.current;
		afterClose.current = null;
		target?.focus();
	}, [panel]);

	const open = (next: Exclude<Panel, null>) => {
		opener.current = document.activeElement;
		setPanel(next);
	};
	const close = (focus: "trigger" | "card") => {
		afterClose.current = focus;
		setPanel(null);
	};

	const movable = card.column !== "running";
	const move = (column: MovableColumn, before: string | null) => {
		keepFocus(card.id);
		onMove(card.id, card.revision, column, before);
	};
	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (
			event.target !== event.currentTarget ||
			!event.altKey ||
			!movable ||
			busy ||
			(event.key !== "ArrowUp" && event.key !== "ArrowDown")
		)
			return;
		event.preventDefault();
		const column = card.column as MovableColumn;
		const peers = othersIn(cards, column, card.id);
		const index = cards
			.filter((c) => c.column === column)
			.findIndex((c) => c.id === card.id);
		if (event.key === "ArrowUp") {
			const above = peers[index - 1];
			if (above) move(column, above.id);
		} else if (index < peers.length) {
			move(column, peers[index + 1]?.id ?? null);
		}
	};

	const actions = ACTION_ORDER.filter((a) => card.actions.includes(a));
	const run = (action: KanbanCardAction) => {
		if (action === "edit" || action === "followup" || action === "remove")
			return open(action);
		if (action === "commitPush") return setConfirming(card);
		onAction(action as Act, card.id, card.revision);
	};
	const disabled = (action: KanbanCardAction) =>
		busy || (NEEDS_RUN.has(action) && !runnable);
	const time = updatedText(card.updatedAt);

	return (
		<li
			className="kanban-item"
			data-dragging={dragging || undefined}
			data-card-id={card.id}
		>
			<article
				ref={article}
				className="kanban-card"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a card is focusable so Alt+arrows can reorder it
				tabIndex={0}
				aria-labelledby={titleId}
				aria-keyshortcuts={movable ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
				data-column={card.column}
				data-label={card.label}
				draggable={movable && !busy && panel === null}
				onKeyDown={onKeyDown}
				onDragStart={(e) => onDragStart(card.id, e)}
				onDragEnd={onDragEnd}
			>
				<header className="kanban-card-head">
					{movable && (
						<GripVertical
							className="kanban-grip"
							aria-hidden="true"
							size={16}
						/>
					)}
					<h4 id={titleId} className="kanban-card-title">
						{card.title}
					</h4>
					{card.label === "done" && (
						<span className="kanban-label" data-label="done">
							<Check aria-hidden="true" size={14} />
							Done
						</span>
					)}
					{card.label === "blocker" && (
						<span className="kanban-label" data-label="blocker">
							<OctagonAlert aria-hidden="true" size={14} />
							Blocker
						</span>
					)}
				</header>
				{card.statusText && <p className="kanban-status">{card.statusText}</p>}
				{card.reasonText && <p className="kanban-reason">{card.reasonText}</p>}
				{(card.reviewed || card.commitPushReported) && (
					<ul className="kanban-marks">
						{card.reviewed && <li>確認済み</li>}
						{card.commitPushReported && <li>commit & push の報告あり</li>}
					</ul>
				)}
				{card.followedByOtherRun && (
					<p className="kanban-warning">
						<TriangleAlert aria-hidden="true" size={14} />
						このタスクの後に別のタスクが実行されています
					</p>
				)}
				{time && (
					<p className="kanban-time">
						<time dateTime={card.updatedAt}>更新 {time}</time>
					</p>
				)}
				<Button
					type="button"
					size="sm"
					variant="ghost"
					className="kanban-toggle"
					aria-expanded={expanded}
					aria-controls={detailId}
					onClick={() => setExpanded((v) => !v)}
				>
					{expanded ? "詳細を閉じる" : "詳細を見る"}
				</Button>
				{expanded && (
					<div id={detailId} className="kanban-detail">
						<section aria-label="依頼内容">
							<h5>依頼内容</h5>
							<p className="kanban-prompt">{card.prompt}</p>
						</section>
						<section aria-label="最後の報告">
							<h5>最後の報告</h5>
							{card.lastReport ? (
								// biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region of a long report
								<div className="kanban-report" tabIndex={0}>
									{card.lastReport}
								</div>
							) : (
								<p className="kanban-muted">報告はまだありません。</p>
							)}
						</section>
						<section aria-label="変更したファイル">
							<h5>変更したファイル</h5>
							{card.files.length > 0 ? (
								<ul className="kanban-files">
									{card.files.map((file) => (
										<li key={file}>{file}</li>
									))}
								</ul>
							) : (
								<p className="kanban-muted">記録された変更はありません。</p>
							)}
						</section>
					</div>
				)}
				{/* Kept mounted while a panel is open so cancelling can focus its button again. */}
				<fieldset
					className="kanban-actions"
					aria-label={`「${card.title}」の操作`}
					hidden={panel !== null}
				>
					{actions.map((action) => (
						<Button
							key={action}
							type="button"
							size="sm"
							variant={VARIANT[action] ?? "outline"}
							maxLabelLength={LABEL_MAX}
							disabled={disabled(action)}
							onClick={() => run(action)}
						>
							{actionLabel(action, card)}
						</Button>
					))}
					{movable && (
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={busy}
							onClick={() => open("move")}
						>
							移動
						</Button>
					)}
				</fieldset>
				{panel === "edit" && (
					<TaskForm
						label={`「${card.title}」を編集`}
						submitLabel="保存"
						initial={{ title: card.title, prompt: card.prompt }}
						disabled={busy}
						onCancel={() => close("trigger")}
						onSubmit={(next) => {
							onEdit(card.id, card.revision, {
								...(next.title !== card.title ? { title: next.title } : {}),
								...(next.prompt !== card.prompt ? { prompt: next.prompt } : {}),
							});
							close("card");
						}}
					/>
				)}
				{panel === "followup" && (
					<NoteForm
						disabled={busy || !runnable}
						onCancel={() => close("trigger")}
						onSubmit={(note) => {
							onAction("followup", card.id, card.revision, { note });
							close("card");
						}}
					/>
				)}
				{panel === "move" && (
					<MoveMenu
						card={card}
						cards={cards}
						disabled={busy}
						onCancel={() => close("trigger")}
						onMove={(column, before) => {
							move(column, before);
							close("card");
						}}
					/>
				)}
				{panel === "remove" && (
					<fieldset className="kanban-form" aria-label="削除の確認">
						<p>「{card.title}」を削除します。元に戻せません。</p>
						<div className="kanban-form-actions">
							<Button
								type="button"
								size="sm"
								variant="destructive"
								disabled={busy}
								onClick={() => {
									onAction("remove", card.id, card.revision);
									close("card");
								}}
							>
								削除する
							</Button>
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={() => close("trigger")}
							>
								やめる
							</Button>
						</div>
					</fieldset>
				)}
			</article>
			{confirming && (
				<CommitPushDialog
					card={confirming}
					current={card}
					onShow={setConfirming}
					onConfirm={() => {
						setConfirming(null);
						onAction("commitPush", confirming.id, confirming.revision);
					}}
				/>
			)}
		</li>
	);
}
