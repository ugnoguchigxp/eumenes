import { ChevronLeft, ChevronRight } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/Button/Button";
import { cn } from "@/utils/cn";

export interface StepGuideStep {
	title: string;
	body?: string;
}

export interface StepGuideProps {
	steps: ReadonlyArray<StepGuideStep>;
	/** 現在のステップ（0 始まり）。指定すると制御モードになる。 */
	step?: number;
	/** 非制御モードの初期ステップ（0 始まり）。 */
	defaultStep?: number;
	onStepChange?: (step: number) => void;
	/** 見出し。ナビゲーションの名前にも使う。 */
	title?: string;
	className?: string;
}

const clampStep = (value: number | undefined, count: number): number => {
	if (value === undefined || !Number.isFinite(value)) return 0;
	return Math.min(Math.max(Math.trunc(value), 0), Math.max(count - 1, 0));
};

/**
 * 前へ・次へと番号ボタンで進める、ステップ解説。
 * 状態は `step` を渡すと呼び出し側が持ち（制御）、渡さなければ部品内で持つ（非制御）。
 * 一覧は NavigationStepper を使わず専用に作る。前後ボタンと本文の表示が要り、
 * 最大 12 件でも横にあふれないようにするため。
 */
const StepGuide = React.forwardRef<HTMLElement, StepGuideProps>(
	({ steps, step, defaultStep, onStepChange, title, className }, ref) => {
		const count = steps.length;
		const [innerStep, setInnerStep] = React.useState(() =>
			clampStep(defaultStep, count),
		);
		const controlled = step !== undefined;
		const current = clampStep(controlled ? step : innerStep, count);
		const buttonRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
		const headingId = React.useId();

		const goTo = React.useCallback(
			(next: number, moveFocus = false) => {
				const target = clampStep(next, count);
				if (target === current) return;
				if (!controlled) setInnerStep(target);
				onStepChange?.(target);
				if (moveFocus) buttonRefs.current[target]?.focus();
			},
			[controlled, count, current, onStepChange],
		);

		if (count === 0) return null;

		const active = steps[current];
		const atStart = current === 0;
		const atEnd = current === count - 1;

		const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
			switch (event.key) {
				case "ArrowRight":
				case "ArrowDown":
					event.preventDefault();
					goTo(current + 1, true);
					break;
				case "ArrowLeft":
				case "ArrowUp":
					event.preventDefault();
					goTo(current - 1, true);
					break;
				case "Home":
					event.preventDefault();
					goTo(0, true);
					break;
				case "End":
					event.preventDefault();
					goTo(count - 1, true);
					break;
			}
		};

		return (
			<section
				ref={ref}
				aria-label={title ?? "ステップ解説"}
				className={cn(
					"flex w-full flex-col gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground",
					className,
				)}
			>
				{title ? (
					<h3 className="m-0 text-sm font-semibold text-foreground">{title}</h3>
				) : null}

				<ol
					aria-label="ステップ一覧"
					className="m-0 flex list-none flex-wrap gap-1.5 p-0"
				>
					{steps.map((item, index) => {
						const isCurrent = index === current;
						const isDone = index < current;
						return (
							<li key={`${index}-${item.title}`}>
								<button
									type="button"
									ref={(node) => {
										buttonRefs.current[index] = node;
									}}
									aria-current={isCurrent ? "step" : undefined}
									aria-label={`ステップ${index + 1}: ${item.title}`}
									title={item.title}
									onClick={() => goTo(index)}
									onKeyDown={handleKeyDown}
									className={cn(
										"flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
										isCurrent
											? "border-primary bg-primary text-primary-foreground"
											: isDone
												? "border-primary bg-primary/15 text-foreground hover:bg-primary/25"
												: "border-border bg-background text-muted-foreground hover:bg-accent",
									)}
								>
									{index + 1}
								</button>
							</li>
						);
					})}
				</ol>

				<div
					role="group"
					aria-labelledby={headingId}
					aria-live="polite"
					className="flex min-h-20 flex-col gap-1"
				>
					<div className="text-xs text-muted-foreground">
						{current + 1} / {count}
					</div>
					<h4
						id={headingId}
						className="m-0 text-base font-semibold text-foreground"
					>
						{active?.title}
					</h4>
					{active?.body ? (
						<p className="m-0 whitespace-pre-line text-sm leading-relaxed text-foreground">
							{active.body}
						</p>
					) : null}
				</div>

				<div className="flex items-center justify-between gap-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={atStart}
						onClick={() => goTo(current - 1)}
					>
						<ChevronLeft className="mr-1 h-4 w-4" aria-hidden="true" />
						前へ
					</Button>
					<Button
						type="button"
						size="sm"
						disabled={atEnd}
						onClick={() => goTo(current + 1)}
					>
						次へ
						<ChevronRight className="ml-1 h-4 w-4" aria-hidden="true" />
					</Button>
				</div>
			</section>
		);
	},
);
StepGuide.displayName = "StepGuide";

export { StepGuide };
