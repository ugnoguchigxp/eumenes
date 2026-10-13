import { useId } from "react";
import type { TimerDraft } from "./TimerWorkspace";

/** Duration stays in one place; only a fresh timer's draft is editable. */
export function TimerDurationFields({
	value,
	disabled,
	readOnly,
	onChange,
}: {
	value: TimerDraft;
	disabled?: boolean;
	readOnly: boolean;
	onChange: (key: keyof TimerDraft, value: string) => void;
}) {
	const id = useId();
	return (
		<div
			className="timer-workspace-time-inputs"
			role="group"
			aria-label="設定時間"
		>
			{(
				[
					["hours", "時間"],
					["minutes", "分"],
					["seconds", "秒"],
				] as const
			).map(([key, label], index) => (
				<div className="timer-workspace-time-part" key={key}>
					{index > 0 && (
						<span className="timer-workspace-colon" aria-hidden="true">
							:
						</span>
					)}
					<label htmlFor={`${id}-${key}`}>
						<input
							id={`${id}-${key}`}
							type="number"
							inputMode="numeric"
							min={0}
							step={1}
							value={value[key]}
							disabled={disabled}
							readOnly={readOnly}
							onFocus={(event) => {
								if (!readOnly) event.target.select();
							}}
							onChange={(event) => {
								if (!readOnly) onChange(key, event.target.value);
							}}
							onBlur={() => {
								if (
									!readOnly &&
									value[key] &&
									Number.isInteger(Number(value[key])) &&
									Number(value[key]) >= 0
								)
									onChange(key, value[key].padStart(2, "0"));
							}}
						/>
						<span>{label}</span>
					</label>
				</div>
			))}
		</div>
	);
}
