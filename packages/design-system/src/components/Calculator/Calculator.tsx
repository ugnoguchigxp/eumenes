/* oxlint-disable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions --
   The keypad group takes focus and key presses so numbers can be typed; its buttons stay the interactive parts. */
import { Calculator as CalculatorIcon } from "lucide-react";
import { type KeyboardEvent, useCallback, useState } from "react";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { cn } from "@/utils/cn";
import { evaluateExpression } from "./calculator-expression";

export interface CalculatorProps {
	/** Called with the result when "=" is pressed. */
	onResult?: (result: number) => void;
	className?: string;
	/** Label for calculator button. Default: "電卓" */
	buttonLabel?: string;
	/**
	 * `inline` shows the keypad in the page, `modal` behind a button. Without it, a calculator
	 * with `onResult` is shown inline and one without is shown in a modal.
	 */
	display?: "modal" | "inline";
	/** `scientific` adds sin, cos, tan (degrees), sqrt, ^, pi and parentheses. Default: basic */
	mode?: "basic" | "scientific";
	/** An expression typed in beforehand; the user presses "=" to work it out. */
	initialExpression?: string;
	/** Works an expression out for the calculator; `null` is shown as an error. */
	evaluate?: (expression: string) => number | null;
}

const ERROR_TEXT = "エラー";
const OPERATORS = ["+", "-", "*", "/"] as const;
const isOperator = (value: string) =>
	(OPERATORS as readonly string[]).includes(value);

interface Key {
	/** Text on the key. */
	label: string;
	/** Text appended to the expression; the key's action when absent. */
	insert?: string;
	action?: "equals" | "clear" | "backspace";
	/** What the key is called for assistive technology. */
	name?: string;
	/** Columns the key spans. */
	span?: number;
}

const basicKeys: Key[] = [
	..."789".split("").map((c) => ({ label: c, insert: c })),
	{ label: "/", insert: "/" },
	..."456".split("").map((c) => ({ label: c, insert: c })),
	{ label: "*", insert: "*" },
	..."123".split("").map((c) => ({ label: c, insert: c })),
	{ label: "-", insert: "-" },
	{ label: "0", insert: "0" },
	{ label: ".", insert: "." },
	{ label: "=", action: "equals" },
	{ label: "+", insert: "+" },
	{ label: "C", action: "clear", span: 2 },
	{ label: "⌫", action: "backspace", name: "1文字削除", span: 2 },
];

const scientificKeys: Key[] = [
	{ label: "sin", insert: "sin(" },
	{ label: "cos", insert: "cos(" },
	{ label: "tan", insert: "tan(" },
	{ label: "√", insert: "sqrt(" },
	{ label: "(", insert: "(" },
	{ label: ")", insert: ")" },
	{ label: "^", insert: "^" },
	{ label: "π", insert: "pi" },
];

/** Inserts that start a new number or group, replacing a lone "0" or the last result. */
const startsOperand = (insert: string) =>
	/^[0-9.(]/.test(insert) || /^[a-z]/.test(insert);

/** Whether `insert` would run into `base` as an implicit product (2pi, 3(, (1+2)3, pi2). */
const needsMultiplication = (base: string, insert: string) => {
	if (/^[a-z(]/.test(insert)) return /[0-9.)]$|pi$/.test(base);
	if (/^[0-9.]/.test(insert)) return /\)$|pi$/.test(base);
	return false;
};

/** The tail one Backspace removes: a spaced operator, a function name, pi or one character. */
const BACKSPACE_TAIL = /(?: [+\-*/^] |(?:sin|cos|tan|sqrt)\(|pi|[\s\S])$/;

export const Calculator = ({
	onResult,
	className,
	buttonLabel = "電卓",
	display = onResult ? "inline" : "modal",
	mode = "basic",
	initialExpression,
	evaluate,
}: CalculatorProps) => {
	const [isOpen, setIsOpen] = useState(false);
	const [expression, setExpression] = useState(initialExpression || "0");
	// After "=", typing a number starts over while an operator continues from the result.
	const [showsResult, setShowsResult] = useState(false);
	const scientific = mode === "scientific";

	// Moves focus into the pad when it opens in a modal, so typing works at once.
	const focusOnOpen = useCallback(
		(node: HTMLDivElement | null) => {
			if (display === "modal") node?.focus();
		},
		[display],
	);

	const calculate = (source: string): number | null => {
		try {
			const result = evaluate ? evaluate(source) : evaluateExpression(source);
			return result !== null && Number.isFinite(result) ? result : null;
		} catch {
			return null;
		}
	};

	const press = (key: Key) => {
		if (key.action === "equals") {
			const result = calculate(expression);
			if (result === null) {
				setExpression(ERROR_TEXT);
				setShowsResult(false);
				return;
			}
			setExpression(result.toString());
			setShowsResult(true);
			onResult?.(result);
			return;
		}
		if (key.action === "clear") {
			setExpression("0");
			setShowsResult(false);
			return;
		}
		if (key.action === "backspace") {
			const next =
				expression === ERROR_TEXT || showsResult
					? ""
					: expression.replace(BACKSPACE_TAIL, "");
			setExpression(next === "" ? "0" : next);
			setShowsResult(false);
			return;
		}
		const insert = key.insert ?? "";
		const fresh =
			expression === ERROR_TEXT || (showsResult && startsOperand(insert));
		const base = fresh ? "0" : expression;
		const replacesZero =
			base === "0" && startsOperand(insert) && insert !== ".";
		let text =
			scientific && (isOperator(insert) || insert === "^")
				? ` ${insert} `
				: insert;
		// The expression language has no implicit multiplication: 2pi, 3( and (1+2)3 get a " * ".
		if (!replacesZero && needsMultiplication(base, insert)) text = ` * ${text}`;
		setShowsResult(false);
		setExpression(replacesZero ? text : `${base}${text}`);
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		const { key } = event;
		const onButton = event.target instanceof HTMLButtonElement;
		let handled: Key | undefined;
		if (/^[0-9.]$/.test(key) || isOperator(key)) {
			handled = { label: key, insert: key };
		} else if (scientific && (key === "(" || key === ")" || key === "^")) {
			handled = { label: key, insert: key };
		} else if (key === "=" || (key === "Enter" && !onButton)) {
			handled = { label: "=", action: "equals" };
		} else if (key === "Backspace") {
			handled = { label: "⌫", action: "backspace" };
		} else if (key === "Escape" && expression !== "0") {
			// A cleared calculator lets Escape reach the modal that holds it.
			handled = { label: "C", action: "clear" };
		}
		if (!handled) return;
		event.preventDefault();
		event.stopPropagation();
		press(handled);
	};

	const keys = scientific ? [...scientificKeys, ...basicKeys] : basicKeys;

	const content = (
		<div
			ref={focusOnOpen}
			role="group"
			aria-label="電卓"
			tabIndex={0}
			onKeyDown={handleKeyDown}
			className={cn(
				"space-y-4 rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				className,
			)}
		>
			<div
				role="status"
				aria-live="polite"
				className="bg-muted p-4 rounded text-right text-2xl font-mono text-foreground break-all"
			>
				{expression}
			</div>
			{scientific && (
				<p className="text-xs text-muted-foreground">
					三角関数は度数法です。例: tan(45) = 1
				</p>
			)}
			<div className="grid grid-cols-4 gap-2">
				{keys.map((key) => (
					<Button
						key={key.label}
						type="button"
						aria-label={key.name}
						onClick={() => press(key)}
						variant={key.action === "equals" ? "default" : "outline"}
						className={cn(
							key.span === 2 ? "col-span-2" : "h-auto aspect-[5/4]",
						)}
					>
						{key.label}
					</Button>
				))}
			</div>
		</div>
	);

	if (display === "inline") {
		return content;
	}

	return (
		<div className="space-y-4">
			<Button variant="outline" size="lg" onClick={() => setIsOpen(true)}>
				<CalculatorIcon className="me-2 h-4 w-4" />
				{buttonLabel}
			</Button>
			<Modal open={isOpen} onOpenChange={setIsOpen} title={buttonLabel}>
				{content}
			</Modal>
		</div>
	);
};
