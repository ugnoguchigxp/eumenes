import { Calculator as CalculatorIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";

export interface CalculatorProps {
	onResult?: (result: number) => void;
	className?: string;
	/** Label for calculator button. Default: "Calculator" */
	buttonLabel?: string;
}

export const Calculator = ({
	onResult,
	className,
	buttonLabel = "Calculator",
}: CalculatorProps) => {
	const [isOpen, setIsOpen] = useState(false);
	const [display, setDisplay] = useState("0");

	const isOperator = (value: string) => ["+", "-", "*", "/"].includes(value);

	const evaluateExpression = (expression: string): number => {
		const sanitized = expression.replace(/\s+/g, "");
		if (!/^[0-9.+\-*/]+$/.test(sanitized)) {
			throw new Error("invalid");
		}

		const output: number[] = [];
		const operators: string[] = [];
		const precedence: Record<string, number> = {
			"+": 1,
			"-": 1,
			"*": 2,
			"/": 2,
		};

		const flushOperator = () => {
			const op = operators.pop();
			if (!op) return;
			const b = output.pop();
			const a = output.pop();
			if (a === undefined || b === undefined) {
				throw new Error("invalid");
			}
			switch (op) {
				case "+":
					output.push(a + b);
					break;
				case "-":
					output.push(a - b);
					break;
				case "*":
					output.push(a * b);
					break;
				case "/":
					if (b === 0) throw new Error("div0");
					output.push(a / b);
					break;
				default:
					throw new Error("invalid");
			}
		};

		const tokens = sanitized.match(/(\d+(?:\.\d+)?|[+\-*/])/g);
		if (!tokens) {
			throw new Error("invalid");
		}

		for (const token of tokens) {
			if (isOperator(token)) {
				while (
					operators.length > 0 &&
					(() => {
						const lastOp = operators[operators.length - 1];
						if (!lastOp) {
							return false;
						}
						const lastPrecedence = precedence[lastOp];
						const tokenPrecedence = precedence[token];
						return (
							lastPrecedence !== undefined &&
							tokenPrecedence !== undefined &&
							lastPrecedence >= tokenPrecedence
						);
					})()
				) {
					flushOperator();
				}
				operators.push(token);
			} else {
				output.push(Number(token));
			}
		}

		while (operators.length > 0) {
			flushOperator();
		}

		if (output.length !== 1 || Number.isNaN(output[0])) {
			throw new Error("invalid");
		}
		const [result] = output;
		if (result === undefined) {
			throw new Error("invalid");
		}
		return result;
	};

	const handleButtonClick = (value: string) => {
		if (value === "=") {
			try {
				const result = evaluateExpression(display);
				setDisplay(result.toString());
				if (onResult) {
					onResult(result);
				}
			} catch {
				setDisplay("Error");
			}
		} else if (value === "C") {
			setDisplay("0");
		} else {
			if (display === "Error") {
				setDisplay(value);
				return;
			}
			const next =
				display === "0" && !isOperator(value) ? value : `${display}${value}`;
			setDisplay(next);
		}
	};

	const buttons = useMemo(
		() => [
			"7",
			"8",
			"9",
			"/",
			"4",
			"5",
			"6",
			"*",
			"1",
			"2",
			"3",
			"-",
			"0",
			".",
			"=",
			"+",
			"C",
		],
		[],
	);

	const CalculatorContent = (
		<div className={`space-y-4 ${className || ""}`}>
			<div className="bg-muted p-4 rounded text-right text-2xl font-mono text-foreground">
				{display}
			</div>
			<div className="grid grid-cols-4 gap-2">
				{buttons.map((btn) => (
					<Button
						key={btn}
						onClick={() => handleButtonClick(btn)}
						variant={btn === "=" ? "default" : "outline"}
						className={btn === "C" ? "col-span-4" : "h-auto aspect-[5/4]"}
					>
						{btn}
					</Button>
				))}
			</div>
		</div>
	);

	if (onResult) {
		return CalculatorContent;
	}

	return (
		<div className="space-y-4">
			<Button variant="outline" size="lg" onClick={() => setIsOpen(true)}>
				<CalculatorIcon className="me-2 h-4 w-4" />
				{buttonLabel}
			</Button>
			<Modal open={isOpen} onOpenChange={setIsOpen} title={buttonLabel}>
				{CalculatorContent}
			</Modal>
		</div>
	);
};
