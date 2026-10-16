import { type DragEvent, Fragment, useId, useRef } from "react";
import { KanbanCard, type KanbanCardProps } from "./KanbanCard";
import { dropBeforeId, type MovableColumn } from "./positions";
import type { KanbanBoardCard, KanbanBoardColumn } from "./types";

type KanbanColumnProps = Omit<KanbanCardProps, "card" | "dragging"> & {
	id: KanbanBoardColumn;
	label: string;
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
	empty,
	draggingId,
	dropBefore,
	onDropTarget,
	onDropLeave,
	onDropCard,
	...card
}: KanbanColumnProps) {
	const labelId = useId();
	const list = useRef<HTMLUListElement>(null);
	const items = card.cards.filter((c) => c.column === id);
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
				<span className="kanban-count">{items.length}</span>
			</h3>
			{/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- handles keys or drag events that bubble up from its interactive children */}
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
				{items.length === 0 && dropBefore === undefined && (
					<li className="kanban-empty">{empty}</li>
				)}
				{items.map((c: KanbanBoardCard) => (
					<Fragment key={c.id}>
						{dropBefore === c.id && c.id !== draggingId && line}
						<KanbanCard {...card} card={c} dragging={c.id === draggingId} />
					</Fragment>
				))}
				{dropBefore === null && line}
			</ul>
		</section>
	);
}
