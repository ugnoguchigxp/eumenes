import {
	type FormEvent,
	type KeyboardEvent,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { Button } from "../Button";
import {
	isNoopMove,
	MOVE_TARGETS,
	type MovableColumn,
	nextSiblingId,
	othersIn,
} from "./positions";
import type { KanbanBoardCard } from "./types";

type MoveMenuProps = {
	card: KanbanBoardCard;
	cards: readonly KanbanBoardCard[];
	disabled?: boolean;
	onMove: (column: MovableColumn, beforeCardId: string | null) => void;
	onCancel: () => void;
};

/**
 * The keyboard-first way to move a card: pick the column, then the card it goes before (or the
 * end). Dragging is only an aid on top of this.
 */
export function MoveMenu({
	card,
	cards,
	disabled,
	onMove,
	onCancel,
}: MoveMenuProps) {
	const name = useId();
	const positionId = useId();
	const [column, setColumn] = useState<MovableColumn>(
		card.column === "finished" ? "finished" : "todo",
	);
	const [before, setBefore] = useState<string>(
		nextSiblingId(cards, card.id) ?? "",
	);
	const form = useRef<HTMLFormElement>(null);
	useEffect(
		() =>
			form.current
				?.querySelector<HTMLInputElement>("input[type=radio]:checked")
				?.focus(),
		[],
	);
	const options = othersIn(cards, column, card.id);
	const target = before === "" ? null : before;
	const noop = isNoopMove(cards, card.id, column, target);
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!noop && !disabled) onMove(column, target);
	};
	const key = (event: KeyboardEvent<HTMLFormElement>) => {
		if (event.key !== "Escape") return;
		event.stopPropagation();
		onCancel();
	};
	return (
		<form
			ref={form}
			className="kanban-form kanban-move"
			aria-label="移動先を選ぶ"
			onSubmit={submit}
			onKeyDown={key}
		>
			<fieldset className="kanban-move-columns">
				<legend>移動先の列</legend>
				{MOVE_TARGETS.map((c) => (
					<label key={c.id} className="kanban-radio">
						<input
							type="radio"
							name={name}
							value={c.id}
							checked={column === c.id}
							onChange={() => {
								setColumn(c.id);
								setBefore("");
							}}
						/>
						{c.label}
					</label>
				))}
			</fieldset>
			<div className="kanban-field">
				<label htmlFor={positionId}>位置</label>
				<select
					id={positionId}
					className="kanban-select"
					value={before}
					onChange={(e) => setBefore(e.target.value)}
				>
					{options.map((c) => (
						<option key={c.id} value={c.id}>
							{`「${c.title}」の前`}
						</option>
					))}
					<option value="">列の末尾</option>
				</select>
			</div>
			<div className="kanban-form-actions">
				<Button type="submit" size="sm" disabled={noop || disabled}>
					移動する
				</Button>
				<Button type="button" size="sm" variant="outline" onClick={onCancel}>
					キャンセル
				</Button>
			</div>
		</form>
	);
}
