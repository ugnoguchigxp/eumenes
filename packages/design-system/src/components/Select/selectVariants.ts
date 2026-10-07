import { cva, type VariantProps } from "class-variance-authority";

export const selectTriggerVariants = cva(
	[
		"w-full inline-flex items-center justify-between gap-2 whitespace-nowrap",
		"rounded-[calc(var(--radius,0.5rem)-2px)]",
		"border border-solid border-border",
		"bg-background text-foreground",
		"transition-[border-color,box-shadow,background-color,color] duration-150 ease-in-out",
		"focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
		"disabled:cursor-not-allowed disabled:opacity-50",
	].join(" "),
	{
		variants: {
			variant: {
				default: "",
				outline: "bg-transparent",
				ghost: "bg-transparent border-transparent shadow-none",
			},
			size: {
				sm: "min-h-[32px] px-3 py-1 text-sm",
				md: "h-ui px-3 text-ui min-h-ui-touch",
				lg: "h-12 px-5 py-3 text-lg",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "md",
		},
	},
);

export const selectItemVariants = cva(
	[
		"relative flex w-full select-none items-center rounded-sm",
		"outline-none",
		"focus:bg-accent focus:text-accent-foreground",
		"data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
		"border-b border-border last:border-b-0",
	].join(" "),
	{
		variants: {
			indicator: {
				none: "",
				check: "",
			},
			size: {
				sm: "min-h-[32px] py-1.5 text-sm",
				md: "h-auto text-ui min-h-[var(--ui-list-row-height)]",
				lg: "min-h-[48px] py-3 text-lg",
			},
			padding: {
				plain: "px-ui",
				withIndicator: "pl-[calc(var(--ui-component-padding-x)+1.5rem)] pr-ui",
			},
		},
		defaultVariants: {
			size: "md",
			indicator: "none",
			padding: "plain",
		},
	},
);

export type SelectTriggerVariants = VariantProps<typeof selectTriggerVariants>;
export type SelectItemVariants = VariantProps<typeof selectItemVariants>;
