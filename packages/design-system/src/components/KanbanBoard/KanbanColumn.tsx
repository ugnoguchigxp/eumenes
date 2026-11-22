import { type DragEvent, Fragment, useId, useRef } from "react";
import { KanbanCard, type KanbanCardProps } from "./KanbanCard";
import { dropBeforeId, type MovableColumn } from "./positions";
import type {
	KanbanBoardCard,
	KanbanBoardColumn,
	KanbanBoardProps,
} from "./types";
import { type ConditionDraft, SupervisedRow } from "./SupervisedRow";

type KanbanColumnProps = Omit<KanbanCardProps, "card" | "dragging"> & {
	supervisedRows?: KanbanBoardProps["supervisedRows"];
	drafts: Record<string, ConditionDraft>;
	onDraft: (taskId: string, draft: ConditionDraft | null) => void;
	onSupervisedControl?: KanbanBoardProps["onSupervisedControl"];
	id: KanbanBoardColumn;
	label: string;
	description: string;
	empty: string;
	draggingId: string | null;
	/** Where the dragged card would land in this column; undefined when it is not a target. */
	dropBefore: string | null | undefined;
	onDropTarget: (column: MovableColumn, before: string | null) => void;
	onDropLeave: () => void;
	onDropCard: (column: MovableColumn, before: string | null) => void;
};

export function KanbanColumn({
	id,
	label,
	description,
	empty,
	draggingId,
	dropBefore,
	onDropTarget,
	onDropLeave,
	onDropCard,
	supervisedRows,
	onSupervisedControl,
	drafts,
	onDraft,
	...card
}: KanbanColumnProps) {
	const labelId = useId();
	const list = useRef<HTMLUListElement>(null);
	const items = card.cards.filter((c) => c.column === id);
	const supervised = supervisedRows?.filter((row) => row.column === id) ?? [];
	const accepts = id !== "running" && draggingId !== null;

	const beforeAt = (event: DragEvent): string | null => {
		const rects = [
			...(list.current?.querySelectorAll<HTMLElement>(
				":scope > [data-card-id]",
			) ?? []),
		]
			.filter((el) => el.dataset.cardId !== draggingId)
			.map((el) => {
				const box = el.getBoundingClientRect();
				return {
					id: el.dataset.cardId as string,
					top: box.top,
					height: box.height,
				};
			});
		return dropBeforeId(rects, event.clientY);
	};
	const line = <li className="kanban-drop-line" aria-hidden="true" />;
	return (
		<section
			className="kanban-column"
			aria-labelledby={labelId}
			data-column={id}
			data-drop={dropBefore !== undefined || undefined}
		>
			<h3 className="kanban-column-head">
				<span id={labelId}>{label}</span>
				<span className="kanban-count">{items.length + supervised.length}</span>
			</h3>
			<p className="kanban-column-description">{description}</p>
			{/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- handles keys or drag events that bubble up from its interactive children */}
			<ul
				ref={list}
				className="kanban-list"
				aria-label={`${label}のタスク`}
				onDragOver={(event) => {
					if (!accepts) return;
					event.preventDefault();
					event.dataTransfer.dropEffect = "move";
					onDropTarget(id as MovableColumn, beforeAt(event));
				}}
				onDragLeave={(event) => {
					if (!event.currentTarget.contains(event.relatedTarget as Node | null))
						onDropLeave();
				}}
				onDrop={(event) => {
					if (!accepts) return;
					event.preventDefault();
					onDropCard(id as MovableColumn, beforeAt(event));
				}}
			>
				{items.length === 0 &&
					supervised.length === 0 &&
					dropBefore === undefined && <li className="kanban-empty">{empty}</li>}
				{items.map((c: KanbanBoardCard) => (
					<Fragment key={c.id}>
						{dropBefore === c.id && c.id !== draggingId && line}
						<KanbanCard {...card} card={c} dragging={c.id === draggingId} />
					</Fragment>
				))}
				{dropBefore === null && line}
				{supervised.map((row) => (
					<SupervisedRow
						key={row.taskId}
						row={row}
						draft={drafts[row.taskId]}
						onDraft={onDraft}
						onControl={onSupervisedControl}
						busy={card.busy}
					/>
				))}
			</ul>
		</section>
	);
}
