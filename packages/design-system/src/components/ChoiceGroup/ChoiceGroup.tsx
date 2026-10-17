import { type KeyboardEvent, useId, useRef } from "react";
import { cn } from "../../utils/cn";
import "./ChoiceGroup.css";

export type ChoiceGroupProps = {
	label: string;
	options: string[];
	/** 選択中の選択肢。未選択は空文字（または options に無い値）。 */
	value: string;
	onChange: (value: string) => void;
	/** buttons: セグメントボタン / cards: クイズ・診断向けの大きな選択肢。 */
	display?: "buttons" | "cards";
	/** 無効のとき、選択肢は選べず Tab の到達先にもならない。 */
	disabled?: boolean;
	className?: string;
};

export function ChoiceGroup({
	label,
	options,
	value,
	onChange,
	display = "buttons",
	disabled = false,
	className,
}: ChoiceGroupProps) {
	const labelId = useId();
	const refs = useRef<Array<HTMLButtonElement | null>>([]);
	const selected = options.indexOf(value);
	// 未選択のときは先頭を Tab の到達先にする。
	const tabbable = selected >= 0 ? selected : 0;

	const move = (from: number, delta: number) => {
		const next = (from + delta + options.length) % options.length;
		const option = options[next];
		if (option === undefined) return;
		onChange(option);
		refs.current[next]?.focus();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
		if (event.key === "ArrowRight" || event.key === "ArrowDown") {
			event.preventDefault();
			move(index, 1);
		} else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
			event.preventDefault();
			move(index, -1);
		}
	};

	return (
		<div
			className={cn("ds-choice-group", className)}
			data-display={display}
			data-disabled={disabled || undefined}
		>
			<span id={labelId} className="ds-choice-group-label">
				{label}
			</span>
			<div
				className="ds-choice-group-options"
				role="radiogroup"
				aria-labelledby={labelId}
				aria-disabled={disabled || undefined}
			>
				{options.map((option, index) => (
					<button
						key={`${index}-${option}`}
						ref={(node) => {
							refs.current[index] = node;
						}}
						type="button"
						role="radio"
						aria-checked={index === selected}
						aria-disabled={disabled || undefined}
						disabled={disabled}
						tabIndex={index === tabbable ? 0 : -1}
						className="ds-choice-group-option"
						onClick={() => onChange(option)}
						onKeyDown={(event) => onKeyDown(event, index)}
					>
						<span>{option}</span>
					</button>
				))}
			</div>
		</div>
	);
}
