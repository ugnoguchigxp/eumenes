/**
 * KeypadModal Component
 * 数値・電話番号入力向けのキーパッドモーダル
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/Modal";

type KeypadVariant = "number" | "phone" | "time";
const TIME_MAX_DIGITS = 4;

const sanitizeTimeValue = (value?: string): string => {
	if (!value) return "";
	return value.replace(/[^0-9]/g, "").slice(0, TIME_MAX_DIGITS);
};

const formatTimeDisplay = (value: string): string => {
	const padded = value.padEnd(TIME_MAX_DIGITS, "_");
	return `${padded.slice(0, 2)}:${padded.slice(2, 4)}`;
};

const isValidTimeDigits = (value: string): boolean => {
	if (value.length !== TIME_MAX_DIGITS) return false;
	const hours = Number.parseInt(value.slice(0, 2), 10);
	const minutes = Number.parseInt(value.slice(2, 4), 10);
	return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
};

const toFormattedTime = (value: string): string =>
	`${value.slice(0, 2)}:${value.slice(2, 4)}`;

interface UnifiedKeypadModalProps {
	open: boolean;
	onClose: () => void;
	onSubmit: (value: string) => void;
	variant?: KeypadVariant;
	initialValue?: string;
	title?: string;
	placeholder?: string;
	maxLength?: number;
	allowDecimal?: boolean;
}

interface KeypadLayoutProps {
	open: boolean;
	title: string;
	onClose: () => void;
	displayContent: React.ReactNode;
	errorMessage?: string;
	onNumberClick: (digit: string) => void;
	onBackspace: () => void;
	onClear: () => void;
	onConfirm: () => void;
	additionalButton?: React.ReactNode;
}

const KeypadModalLayout: React.FC<KeypadLayoutProps> = React.memo(
	({
		open,
		title,
		onClose,
		displayContent,
		errorMessage,
		onNumberClick,
		onBackspace,
		onClear,
		onConfirm,
		additionalButton,
	}) => (
		<Modal
			open={open}
			onOpenChange={(isOpen) => !isOpen && onClose()}
			title={title}
			onClose={onClose}
		>
			<div className="flex flex-col gap-4">
				<div className="bg-card border-2 border-theme-text-primary rounded-lg p-[var(--ui-modal-padding)] min-h-[60px] flex items-center justify-center text-lg font-semibold text-foreground">
					{displayContent}
				</div>
				{errorMessage && (
					<div className="text-destructive-foreground text-sm text-center p-2 bg-red-50 dark:bg-red-950 rounded-md border-l-[3px] border-theme-danger">
						{errorMessage}
					</div>
				)}
				<div className="grid grid-cols-3 gap-2">
					{[1, 2, 3, 4, 5, 6, 7, 8, 9].map((num) => (
						<button
							key={num}
							type="button"
							onClick={() => onNumberClick(num.toString())}
							className="min-h-[var(--ui-keypad-button-height)] text-lg font-semibold bg-background text-foreground border-2 border-theme-text-primary rounded-lg cursor-pointer transition-all active:scale-95 active:brightness-90 hover:brightness-110"
						>
							{num}
						</button>
					))}
					{additionalButton || (
						<div className="min-h-[var(--ui-keypad-button-height)] bg-card rounded-lg" />
					)}
					<button
						type="button"
						onClick={() => onNumberClick("0")}
						className="min-h-[var(--ui-keypad-button-height)] text-lg font-semibold bg-background text-foreground border-2 border-theme-text-primary rounded-lg cursor-pointer transition-all active:scale-95 active:brightness-90 hover:brightness-110"
					>
						0
					</button>
					<button
						type="button"
						onClick={onBackspace}
						className="min-h-[var(--ui-keypad-button-height)] text-base font-semibold bg-background text-foreground border-2 border-theme-text-primary rounded-lg cursor-pointer transition-all active:scale-95 active:brightness-90 hover:brightness-110"
					>
						⌫
					</button>
				</div>
				<div className="grid grid-cols-2 gap-2 mt-2">
					<button
						type="button"
						onClick={onClear}
						className="min-h-[var(--ui-keypad-button-height)] text-base font-semibold bg-background text-foreground border-2 border-theme-text-primary rounded-lg cursor-pointer transition-all active:scale-95 active:bg-destructive active:text-white active:border-theme-danger hover:bg-destructive hover:text-white hover:border-theme-danger"
					>
						C
					</button>
					<button
						type="button"
						onClick={onConfirm}
						className="min-h-[var(--ui-keypad-button-height)] text-base font-semibold bg-background text-foreground border-2 border-theme-text-primary rounded-lg cursor-pointer transition-all active:scale-95 active:brightness-90 hover:brightness-110"
					>
						OK
					</button>
				</div>
			</div>
		</Modal>
	),
);

const variantDefaults: Record<
	KeypadVariant,
	{ title: string; placeholder: string; maxLength: number }
> = {
	number: {
		title: "数値を入力",
		placeholder: "",
		maxLength: 10,
	},
	phone: {
		title: "電話番号を入力",
		placeholder: "090-0000-0000",
		maxLength: 13,
	},
	time: {
		title: "時刻を入力",
		placeholder: "__:__",
		maxLength: TIME_MAX_DIGITS,
	},
};

export const KeypadModal: React.FC<UnifiedKeypadModalProps> = React.memo(
	({
		open,
		onClose,
		onSubmit,
		variant = "number",
		initialValue = "",
		title,
		placeholder,
		maxLength,
		allowDecimal = false,
	}) => {
		const sanitizedInitialValue = useMemo(
			() =>
				variant === "time" ? sanitizeTimeValue(initialValue) : initialValue,
			[variant, initialValue],
		);
		const [value, setValue] = useState(sanitizedInitialValue);
		const [error, setError] = useState("");

		const config = useMemo(() => variantDefaults[variant], [variant]);
		const resolvedTitle = title ?? config.title;
		const resolvedPlaceholder = placeholder ?? config.placeholder;
		const resolvedMaxLength =
			variant === "time" ? TIME_MAX_DIGITS : (maxLength ?? config.maxLength);
		const canUseDecimal = variant === "number" && allowDecimal;
		const canUseHyphen = variant === "phone";
		const isTimeVariant = variant === "time";

		useEffect(() => {
			if (open) {
				setValue(sanitizedInitialValue);
				setError("");
			}
		}, [open, sanitizedInitialValue]);

		const handleNumberClick = useCallback(
			(digit: string) => {
				if (isTimeVariant) {
					setValue((prev) => {
						if (prev.length >= TIME_MAX_DIGITS) {
							setError(`最大${TIME_MAX_DIGITS}文字まで入力できます`);
							return prev;
						}
						setError("");
						if (prev.length === 0) {
							const num = Number.parseInt(digit, 10);
							if (num >= 3) {
								return `0${digit}`;
							}
						}
						return (prev + digit).slice(0, TIME_MAX_DIGITS);
					});
					return;
				}

				setValue((prev) => {
					if (prev.length >= resolvedMaxLength) {
						setError(`最大${resolvedMaxLength}文字まで入力できます`);
						return prev;
					}
					setError("");
					return `${prev}${digit}`;
				});
			},
			[resolvedMaxLength, isTimeVariant],
		);

		const handleHyphenClick = useCallback(() => {
			if (!canUseHyphen) return;
			setValue((prev) => {
				if (prev.length >= resolvedMaxLength) {
					setError(`最大${resolvedMaxLength}文字まで入力できます`);
					return prev;
				}
				if (prev.endsWith("-")) {
					setError("ハイフンを連続して入力することはできません");
					return prev;
				}
				setError("");
				return `${prev}-`;
			});
		}, [canUseHyphen, resolvedMaxLength]);

		const handleDecimalClick = useCallback(() => {
			if (!canUseDecimal) return;
			setValue((prev) => {
				if (prev.includes(".")) {
					setError("小数点は1つまでです");
					return prev;
				}
				setError("");
				return `${prev}.`;
			});
		}, [canUseDecimal]);

		const handleBackspace = useCallback(() => {
			setValue((prev) => prev.slice(0, -1));
			setError("");
		}, []);

		const handleClear = useCallback(() => {
			setValue("");
			setError("");
		}, []);

		const handleSubmit = useCallback(() => {
			if (isTimeVariant) {
				setValue((currentValue) => {
					if (!isValidTimeDigits(currentValue)) {
						setError("有効な時刻を 4 桁で入力してください（例: 0930）");
						return currentValue;
					}
					onSubmit(toFormattedTime(currentValue));
					return currentValue;
				});
				return;
			}

			setValue((currentValue) => {
				if (currentValue === "") {
					setError("値を入力してください");
					return currentValue;
				}
				if (canUseDecimal && currentValue.endsWith(".")) {
					setError("小数点で終わることはできません");
					return currentValue;
				}
				if (canUseHyphen && currentValue.endsWith("-")) {
					setError("ハイフンで終わることはできません");
					return currentValue;
				}
				onSubmit(currentValue);
				return currentValue;
			});
		}, [canUseDecimal, canUseHyphen, isTimeVariant, onSubmit]);

		useEffect(() => {
			if (!open) return;

			const handleKeyDown = (e: KeyboardEvent) => {
				if (
					(e.key >= "0" && e.key <= "9") ||
					(e.code >= "Numpad0" && e.code <= "Numpad9")
				) {
					e.preventDefault();
					handleNumberClick(e.key);
				} else if (
					canUseHyphen &&
					(e.key === "-" || e.code === "NumpadSubtract" || e.key === "Minus")
				) {
					e.preventDefault();
					handleHyphenClick();
				} else if (
					canUseDecimal &&
					(e.key === "." || e.code === "NumpadDecimal")
				) {
					e.preventDefault();
					handleDecimalClick();
				} else if (e.key === "Backspace") {
					e.preventDefault();
					handleBackspace();
				} else if (e.key === "Enter") {
					e.preventDefault();
					handleSubmit();
				} else if (e.key === "Escape") {
					e.preventDefault();
					onClose();
				}
			};

			window.addEventListener("keydown", handleKeyDown);
			return () => window.removeEventListener("keydown", handleKeyDown);
		}, [
			open,
			canUseHyphen,
			canUseDecimal,
			onClose,
			handleNumberClick,
			handleHyphenClick,
			handleDecimalClick,
			handleBackspace,
			handleSubmit,
		]);

		const displayContent = isTimeVariant ? (
			<div className="flex flex-col items-center justify-center gap-2 w-full">
				<span
					style={{
						fontSize: "24px",
						fontFamily: "monospace",
						color: "hsl(var(--foreground))",
						letterSpacing: "2px",
						fontWeight: 600,
					}}
				>
					{formatTimeDisplay(value)}
				</span>
				<span
					style={{ fontSize: "12px", color: "var(--theme-text-secondary)" }}
				>
					入力: {value.padEnd(TIME_MAX_DIGITS, "・")}
				</span>
			</div>
		) : (
			<span
				style={{
					fontSize: "24px",
					fontFamily: "monospace",
					color: "hsl(var(--foreground))",
					fontWeight: 600,
				}}
			>
				{value || (
					<span style={{ color: "var(--theme-text-secondary)" }}>
						{resolvedPlaceholder}
					</span>
				)}
			</span>
		);

		const additionalButton = useMemo(() => {
			if (canUseHyphen || canUseDecimal) {
				const label = canUseHyphen ? "-" : ".";
				const clickHandler = canUseHyphen
					? handleHyphenClick
					: handleDecimalClick;
				return (
					<button
						type="button"
						onClick={clickHandler}
						className="min-h-[var(--ui-keypad-button-height)] text-lg font-semibold bg-background text-foreground border-2 border-theme-text-primary rounded-lg cursor-pointer transition-all active:scale-95 active:brightness-90 hover:brightness-110"
					>
						{label}
					</button>
				);
			}
			return undefined;
		}, [canUseHyphen, canUseDecimal, handleHyphenClick, handleDecimalClick]);

		return (
			<KeypadModalLayout
				open={open}
				title={resolvedTitle}
				onClose={onClose}
				displayContent={displayContent}
				errorMessage={error}
				onNumberClick={handleNumberClick}
				onBackspace={handleBackspace}
				onClear={handleClear}
				onConfirm={handleSubmit}
				additionalButton={additionalButton}
			/>
		);
	},
);

KeypadModal.displayName = "KeypadModal";

export default KeypadModal;
