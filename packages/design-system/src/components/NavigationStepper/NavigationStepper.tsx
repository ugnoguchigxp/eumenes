import { Check } from "lucide-react";
import React from "react";
import { cn } from "@/utils/cn";

export interface NavigationStep {
	id: string;
	title: string;
	description?: string;
	disabled?: boolean;
}

export interface NavigationStepperProps {
	steps: NavigationStep[];
	activeStep: number;
	onStepChange?: (nextStep: number) => void;
	renderStepContent?: (step: NavigationStep, index: number) => React.ReactNode;
	orientation?: "horizontal" | "vertical";
	variant?: "split" | "accordion";
	compactOnMobile?: boolean;
	inlineContentOnVerticalMobile?: boolean;
	className?: string;
}

const clamp = (value: number, min: number, max: number) =>
	Math.min(Math.max(value, min), max);

export const NavigationStepper: React.FC<NavigationStepperProps> = React.memo(
	({
		steps,
		activeStep,
		onStepChange,
		renderStepContent,
		orientation = "horizontal",
		variant = "split",
		compactOnMobile = true,
		inlineContentOnVerticalMobile = true,
		className,
	}) => {
		const safeActive = clamp(activeStep, 0, Math.max(steps.length - 1, 0));

		const getStepState = (index: number) => {
			// Allow free navigation if onStepChange is present (implied by previous user request, though that was mock data related)
			// Actually, standard logic:
			if (index < safeActive) return "completed" as const;
			if (index === safeActive) return "current" as const;
			return "upcoming" as const;
		};

		const getCircleClass = (
			state: "completed" | "current" | "upcoming",
			disabled?: boolean,
		) => {
			const base =
				"h-[var(--ui-step-circle-size)] w-[var(--ui-step-circle-size)] rounded-full border-2 flex items-center justify-center text-xs font-semibold flex-shrink-0 transition-colors";

			const stateClass =
				state === "completed"
					? "bg-success border-success text-primary-foreground"
					: state === "current"
						? "bg-primary border-primary text-primary-foreground"
						: "bg-background border-border text-muted-foreground";

			const interactiveClass = onStepChange
				? "cursor-pointer hover:brightness-110"
				: "";
			const disabledClass = disabled
				? "opacity-50 cursor-not-allowed hover:brightness-100"
				: "";

			return cn(base, stateClass, interactiveClass, disabledClass);
		};

		const renderStepButton = (
			index: number,
			content: React.ReactNode,
			disabled?: boolean,
		) => {
			if (!onStepChange) {
				return (
					<div className={cn(disabled ? "pointer-events-none" : "")}>
						{content}
					</div>
				);
			}

			return (
				<button
					type="button"
					onClick={() => {
						if (!disabled) {
							onStepChange(index);
						}
					}}
					disabled={disabled}
					aria-current={index === safeActive ? "step" : undefined}
				>
					{content}
				</button>
			);
		};

		if (steps.length === 0) {
			return null;
		}

		if (orientation === "vertical") {
			const activeStepObj = steps[safeActive];
			const isAccordion = variant === "accordion";

			return (
				<nav aria-label="Progress" className={cn("w-full", className)}>
					<div
						className={cn(
							"grid gap-3",
							isAccordion
								? "grid-cols-1"
								: "grid-cols-1 sm:grid-cols-[192px_1fr]",
						)}
					>
						<ol className="flex flex-col">
							{steps.map((step, index) => {
								const state = getStepState(index);
								const isLast = index === steps.length - 1;
								const isActive = index === safeActive;

								return (
									<li key={step.id} className="flex flex-col">
										<div className="flex items-start gap-2">
											<div className="flex flex-col items-center">
												{renderStepButton(
													index,
													<div className={getCircleClass(state, step.disabled)}>
														{state === "completed" ? (
															<Check className="h-4 w-4" />
														) : (
															index + 1
														)}
													</div>,
													step.disabled,
												)}
												{!isLast && (
													<div
														className={cn(
															"w-0.5 flex-1 mt-2",
															state === "completed"
																? "bg-success"
																: "bg-border",
														)}
														style={{
															minHeight: isAccordion && isActive ? 32 : 16,
														}}
													/>
												)}
											</div>

											<div className="min-w-0 pb-3 flex-1">
												<div className="flex items-center gap-2">
													<div
														className={cn(
															"text-sm font-semibold",
															step.disabled
																? "text-muted-foreground/50"
																: state === "current"
																	? "text-foreground"
																	: "text-muted-foreground",
														)}
													>
														{step.title}
													</div>
													{state === "current" && (
														<span className="text-xs px-2 py-0.5 rounded bg-card text-muted-foreground">
															Current
														</span>
													)}
												</div>
												{step.description && (
													<div className="text-xs text-muted-foreground mt-0.5">
														{step.description}
													</div>
												)}
											</div>
										</div>

										{(inlineContentOnVerticalMobile || isAccordion) &&
											isActive &&
											renderStepContent && (
												<div
													className={cn(
														"w-full pb-8 pl-9", // Indent content in accordion
														!isAccordion && "sm:hidden",
													)}
												>
													<div className="w-full">
														{renderStepContent(step, index)}
													</div>
												</div>
											)}
									</li>
								);
							})}
						</ol>

						{!isAccordion && renderStepContent && activeStepObj && (
							<div className="hidden sm:block">
								<div className="rounded-lg border border-border bg-background p-1">
									{renderStepContent(activeStepObj, safeActive)}
								</div>
							</div>
						)}
					</div>
				</nav>
			);
		}

		const activeStepObj = steps[safeActive];
		const activeTitle = activeStepObj?.title;

		return (
			<nav aria-label="Progress" className={cn("w-full", className)}>
				<div className="flex flex-col gap-3">
					{compactOnMobile && (
						<div
							className="text-sm text-muted-foreground sm:hidden"
							aria-live="polite"
						>
							{safeActive + 1} / {steps.length}
							{activeTitle ? ` - ${activeTitle}` : ""}
						</div>
					)}

					<ol
						className={cn(
							"flex items-center gap-2 overflow-x-auto pb-1",
							compactOnMobile && "sm:overflow-visible",
						)}
					>
						{steps.map((step, index) => {
							const state = getStepState(index);
							const isLast = index === steps.length - 1;
							const isActive = index === safeActive;

							return (
								<React.Fragment key={step.id}>
									<li
										className={cn(
											"flex flex-col items-center flex-shrink-0",
											compactOnMobile
												? "min-w-[40px] sm:min-w-[120px]"
												: "min-w-[120px]",
										)}
									>
										{renderStepButton(
											index,
											<div className={getCircleClass(state, step.disabled)}>
												{state === "completed" ? (
													<Check className="h-4 w-4" />
												) : (
													index + 1
												)}
											</div>,
											step.disabled,
										)}

										<div
											className={cn(
												"mt-2 text-center min-w-0",
												compactOnMobile
													? isActive
														? "sm:block"
														: "hidden sm:block"
													: "block",
											)}
										>
											<div
												className={cn(
													"text-xs font-semibold truncate",
													step.disabled
														? "text-muted-foreground/50"
														: state === "current"
															? "text-foreground"
															: state === "completed"
																? "text-muted-foreground"
																: "text-muted-foreground/50",
												)}
												title={step.title}
											>
												{step.title}
											</div>
											{step.description && (
												<div
													className="hidden sm:block text-xs text-muted-foreground truncate"
													title={step.description}
												>
													{step.description}
												</div>
											)}
										</div>
									</li>

									{!isLast && (
										<div
											className={cn(
												"h-0.5 flex-shrink-0",
												state === "completed" ? "bg-success" : "bg-border",
												compactOnMobile
													? "w-8 min-w-8 sm:w-16"
													: "w-16 min-w-16",
											)}
											aria-hidden="true"
										/>
									)}
								</React.Fragment>
							);
						})}
					</ol>

					{renderStepContent && activeStepObj && (
						<div className="rounded-lg border border-border bg-background p-1">
							{renderStepContent(activeStepObj, safeActive)}
						</div>
					)}
				</div>
			</nav>
		);
	},
);
