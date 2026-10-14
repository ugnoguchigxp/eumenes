import { OctagonAlert, Plus } from "lucide-react";
import {
	type DragEvent,
	type FocusEvent,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { cn } from "@/utils/cn";
import { Button } from "../Button";
import { TaskForm } from "./CardForms";
import { KanbanColumn } from "./KanbanColumn";
import { COLUMNS, isNoopMove, type MovableColumn } from "./positions";
import type { KanbanBoardProps } from "./types";
import "./KanbanBoard.css";

const DEFAULT_NOT_RUNNABLE =
	"この環境では作業の状態を追えないため実行できません";

type DropTarget = { column: MovableColumn; before: string | null };

function queueText(queue: KanbanBoardProps["queue"]) {
	const parts = [
		queue.runningTitle ? `実行中: 「${queue.runningTitle}」` : "",
		queue.waiting > 0 ? `待機中 ${queue.waiting}件` : "",
	].filter(Boolean);
	return parts.length > 0 ? parts.join("・") : "実行待ちのタスクはありません";
}

/**
 * Three-column task board. Keyboard users move a card with its 移動 menu (or Alt+↑/↓ inside a
 * column); dragging is an aid on top. The host owns data, status wording and which actions a
 * card offers; every change goes out as a callback with the card's revision.
 */
export function KanbanBoard(props: KanbanBoardProps) {
	const {
		title,
		cards,
		queue,
		runnable,
		notRunnableText,
		busy = false,
		message,
		className,
		onAdd,
		onMove,
		onResumeQueue,
	} = props;
	const headingId = useId();
	const [adding, setAdding] = useState(false);
	const [dragId, setDragId] = useState<string | null>(null);
	const [target, setTarget] = useState<DropTarget | null>(null);
	const addButton = useRef<HTMLButtonElement>(null);
	const pendingFocus = useRef<string | null>(null);
	const root = useRef<HTMLElement>(null);

	// A card that moved is a different DOM node (or was re-inserted) and drops keyboard focus.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the host redraws cards
	useLayoutEffect(() => {
		const id = pendingFocus.current;
		if (!id) return;
		const active = document.activeElement;
		if (active && active !== document.body) return;
		const node = [
			...(root.current?.querySelectorAll<HTMLElement>("[data-card-id]") ?? []),
		].find((el) => el.dataset.cardId === id);
		pendingFocus.current = null;
		node?.querySelector<HTMLElement>("article")?.focus();
	}, [cards]);

	const forgetFocus = (event: FocusEvent) => {
		const owner = (event.target as HTMLElement)
			.closest("[data-card-id]")
			?.getAttribute("data-card-id");
		if (pendingFocus.current && owner !== pendingFocus.current)
			pendingFocus.current = null;
	};

	const endDrag = () => {
		setDragId(null);
		setTarget(null);
	};
	const drop = (column: MovableColumn, before: string | null) => {
		const card = cards.find((c) => c.id === dragId);
		endDrag();
		if (!card || isNoopMove(cards, card.id, column, before)) return;
		pendingFocus.current = card.id;
		onMove(card.id, card.revision, column, before);
	};
	const startDrag = (cardId: string, event: DragEvent<HTMLElement>) => {
		event.dataTransfer.effectAllowed = "move";
		event.dataTransfer.setData("text/plain", cardId);
		setDragId(cardId);
	};

	return (
		<section
			ref={root}
			className={cn("kanban-board", className)}
			aria-labelledby={headingId}
			aria-busy={busy || undefined}
			onFocusCapture={forgetFocus}
		>
			<header className="kanban-header">
				<h2 id={headingId}>{title ?? "タスクボード"}</h2>
				<Button
					ref={addButton}
					type="button"
					size="sm"
					aria-expanded={adding}
					disabled={busy}
					onClick={() => setAdding((v) => !v)}
				>
					<Plus className="kanban-add-icon" aria-hidden="true" size={16} />
					タスクを追加
				</Button>
			</header>
			{adding && (
				<TaskForm
					label="タスクを追加"
					submitLabel="追加"
					disabled={busy}
					onCancel={() => {
						setAdding(false);
						addButton.current?.focus();
					}}
					onSubmit={(value) => {
						onAdd(value);
						setAdding(false);
						addButton.current?.focus();
					}}
				/>
			)}
			{message && (
				<p className="kanban-message" role="alert">
					{message}
				</p>
			)}
			{!runnable && (
				<p className="kanban-notice" role="status">
					{notRunnableText ?? DEFAULT_NOT_RUNNABLE}
				</p>
			)}
			<section
				className="kanban-queue"
				aria-label="実行キュー"
				data-state={queue.state}
			>
				{queue.state === "paused" ? (
					<>
						<p role="status">
							<OctagonAlert aria-hidden="true" size={16} />
							実行キューは停止中: {queue.reasonText ?? "理由を確認できません"}
							{queue.waiting > 0 && `（待機中 ${queue.waiting}件）`}
						</p>
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={busy}
							onClick={onResumeQueue}
						>
							再開
						</Button>
					</>
				) : (
					<p>{queueText(queue)}</p>
				)}
			</section>
			<div className="kanban-columns">
				{COLUMNS.map((column) => (
					<KanbanColumn
						key={column.id}
						{...column}
						cards={cards}
						runnable={runnable}
						busy={busy}
						draggingId={dragId}
						dropBefore={
							target && target.column === column.id ? target.before : undefined
						}
						onEdit={props.onEdit}
						onMove={onMove}
						onAction={props.onAction}
						onDragStart={startDrag}
						onDragEnd={endDrag}
						keepFocus={(id) => {
							pendingFocus.current = id;
						}}
						onDropTarget={(col, before) => setTarget({ column: col, before })}
						onDropLeave={() => setTarget(null)}
						onDropCard={drop}
					/>
				))}
			</div>
		</section>
	);
}
