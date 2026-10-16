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
import type { KanbanExecutorChoice } from "./types";

export const TITLE_MAX = 40;
/** A task request is the prompt plus fixed instructions; the host sends at most 8000 in all. */
export const PROMPT_MAX = 7850;
export const NOTE_MAX = 4000;
/**
 * A follow-up is sent with the note as a JSON string (a line break counts 2, a quote 2). The host
 * accepts a little more than this (about 7800); the screen stays below it on purpose.
 */
export const NOTE_QUOTED_MAX = 6500;

/** What the note takes in the request, escapes included (without the quotes around it). */
const quotedLength = (note: string) => JSON.stringify(note).length - 2;

function Remaining({ id, left }: { id: string; left: number }) {
	return (
		<p
			id={id}
			className={left < 0 ? "kanban-message" : "kanban-muted"}
			role={left < 0 ? "alert" : undefined}
		>
			{left < 0
				? `${-left}字 長すぎます。短くしてください。`
				: `残り ${left} 字`}
		</p>
	);
}

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
	executors?: readonly KanbanExecutorChoice[];
	defaultExecutorId?: string;
	disabled?: boolean;
	onSubmit: (value: {
		title: string;
		prompt: string;
		executorId?: string;
	}) => void;
	onSubmitAndRun?: (value: {
		title: string;
		prompt: string;
		executorId?: string;
	}) => void;
	onCancel: () => void;
};

/** Title and prompt of a card; used to add a card and to edit one. */
export function TaskForm({
	label,
	submitLabel,
	initial,
	executors,
	defaultExecutorId,
	disabled,
	onSubmit,
	onSubmitAndRun,
	onCancel,
}: TaskFormProps) {
	const ids = { title: useId(), prompt: useId(), left: useId() };
	const [title, setTitle] = useState(initial?.title ?? "");
	const [prompt, setPrompt] = useState(initial?.prompt ?? "");
	const [executorId, setExecutorId] = useState(
		defaultExecutorId ?? executors?.[0]?.id ?? "",
	);
	const executorField = useId();
	const selected = executors?.find((entry) => entry.id === executorId);
	const titleRef = useRef<HTMLInputElement>(null);
	useEffect(() => titleRef.current?.focus(), []);
	const next = {
		title: title.trim(),
		prompt: prompt.trim(),
		...(executors ? { executorId } : {}),
	};
	const changed =
		!initial || next.title !== initial.title || next.prompt !== initial.prompt;
	const ready =
		next.title !== "" &&
		next.prompt !== "" &&
		changed &&
		(!executors || !!selected);
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (ready && !disabled) onSubmit(next);
	};
	return (
		// oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- handles keys or drag events that bubble up from its interactive children
		<form
			className="kanban-form"
			aria-label={label}
			onSubmit={submit}
			onKeyDown={cancelOnEscape(onCancel)}
		>
			{executors && (
				<div className="kanban-field">
					<label htmlFor={executorField}>作業担当</label>
					<select
						id={executorField}
						value={executorId}
						disabled={disabled}
						onChange={(event) => setExecutorId(event.target.value)}
					>
						{!selected && (
							<option value={executorId}>担当を選んでください</option>
						)}
						{executors.map((entry) => (
							<option key={entry.id} value={entry.id}>
								{entry.label}
								{!entry.available ? "（利用できません）" : ""}
							</option>
						))}
					</select>
					{selected && !selected.available && (
						<p role="status">
							{selected.unavailableText ??
								"設定を確認するか、別の担当を選んでください"}
						</p>
					)}
				</div>
			)}
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
					aria-describedby={ids.left}
					onChange={(e) => setPrompt(e.target.value)}
				/>
				<Remaining id={ids.left} left={PROMPT_MAX - prompt.length} />
			</div>
			<div className="kanban-form-actions">
				<Button type="submit" size="sm" disabled={!ready || disabled}>
					{submitLabel}
				</Button>
				{onSubmitAndRun && (
					<Button
						type="button"
						size="sm"
						disabled={!ready || disabled || !selected?.available}
						onClick={() => onSubmitAndRun(next)}
					>
						追加して実行
					</Button>
				)}
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
	const leftId = useId();
	const [note, setNote] = useState("");
	const ref = useRef<HTMLTextAreaElement>(null);
	useEffect(() => ref.current?.focus(), []);
	const trimmed = note.trim();
	const left = Math.min(
		NOTE_MAX - note.length,
		NOTE_QUOTED_MAX - quotedLength(trimmed),
	);
	return (
		// oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- handles keys or drag events that bubble up from its interactive children
		<form
			className="kanban-form"
			aria-label="追加で直す"
			onSubmit={(event) => {
				event.preventDefault();
				if (trimmed && left >= 0 && !disabled) onSubmit(trimmed);
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
					aria-describedby={leftId}
					onChange={(e) => setNote(e.target.value)}
				/>
				<Remaining id={leftId} left={left} />
			</div>
			<div className="kanban-form-actions">
				<Button
					type="submit"
					size="sm"
					disabled={!trimmed || left < 0 || disabled}
				>
					送る
				</Button>
				<Button type="button" size="sm" variant="outline" onClick={onCancel}>
					キャンセル
				</Button>
			</div>
		</form>
	);
}
