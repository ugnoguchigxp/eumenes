import {
	type FormEvent,
	type KeyboardEvent,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { Button } from "../Button";
import { Input } from "../Input";
import { Textarea } from "../Textarea";

export const TITLE_MAX = 40;
export const PROMPT_MAX = 8000;
export const NOTE_MAX = 4000;

const cancelOnEscape =
	(onCancel: () => void) => (event: KeyboardEvent<HTMLFormElement>) => {
		if (event.key !== "Escape") return;
		event.stopPropagation();
		onCancel();
	};

type TaskFormProps = {
	label: string;
	submitLabel: string;
	initial?: { title: string; prompt: string };
	disabled?: boolean;
	onSubmit: (value: { title: string; prompt: string }) => void;
	onCancel: () => void;
};

/** Title and prompt of a card; used to add a card and to edit one. */
export function TaskForm({
	label,
	submitLabel,
	initial,
	disabled,
	onSubmit,
	onCancel,
}: TaskFormProps) {
	const ids = { title: useId(), prompt: useId() };
	const [title, setTitle] = useState(initial?.title ?? "");
	const [prompt, setPrompt] = useState(initial?.prompt ?? "");
	const titleRef = useRef<HTMLInputElement>(null);
	useEffect(() => titleRef.current?.focus(), []);
	const next = { title: title.trim(), prompt: prompt.trim() };
	const changed =
		!initial || next.title !== initial.title || next.prompt !== initial.prompt;
	const ready = next.title !== "" && next.prompt !== "" && changed;
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (ready && !disabled) onSubmit(next);
	};
	return (
		<form
			className="kanban-form"
			aria-label={label}
			onSubmit={submit}
			onKeyDown={cancelOnEscape(onCancel)}
		>
			<div className="kanban-field">
				<label htmlFor={ids.title}>タイトル</label>
				<Input
					id={ids.title}
					ref={titleRef}
					value={title}
					maxLength={TITLE_MAX}
					required
					onChange={(e) => setTitle(e.target.value)}
				/>
			</div>
			<div className="kanban-field">
				<label htmlFor={ids.prompt}>依頼内容</label>
				<Textarea
					id={ids.prompt}
					value={prompt}
					maxLength={PROMPT_MAX}
					rows={5}
					required
					onChange={(e) => setPrompt(e.target.value)}
				/>
			</div>
			<div className="kanban-form-actions">
				<Button type="submit" size="sm" disabled={!ready || disabled}>
					{submitLabel}
				</Button>
				<Button type="button" size="sm" variant="outline" onClick={onCancel}>
					キャンセル
				</Button>
			</div>
		</form>
	);
}

type NoteFormProps = {
	disabled?: boolean;
	onSubmit: (note: string) => void;
	onCancel: () => void;
};

/** The extra request of 「追加で直す」. */
export function NoteForm({ disabled, onSubmit, onCancel }: NoteFormProps) {
	const id = useId();
	const [note, setNote] = useState("");
	const ref = useRef<HTMLTextAreaElement>(null);
	useEffect(() => ref.current?.focus(), []);
	const trimmed = note.trim();
	return (
		<form
			className="kanban-form"
			aria-label="追加で直す"
			onSubmit={(event) => {
				event.preventDefault();
				if (trimmed && !disabled) onSubmit(trimmed);
			}}
			onKeyDown={cancelOnEscape(onCancel)}
		>
			<div className="kanban-field">
				<label htmlFor={id}>追加の依頼</label>
				<Textarea
					id={id}
					ref={ref}
					value={note}
					maxLength={NOTE_MAX}
					rows={4}
					required
					onChange={(e) => setNote(e.target.value)}
				/>
			</div>
			<div className="kanban-form-actions">
				<Button type="submit" size="sm" disabled={!trimmed || disabled}>
					送る
				</Button>
				<Button type="button" size="sm" variant="outline" onClick={onCancel}>
					キャンセル
				</Button>
			</div>
		</form>
	);
}
