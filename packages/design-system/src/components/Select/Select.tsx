import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import * as React from "react";
import { cn } from "@/utils/cn";
import {
	type SelectItemVariants,
	type SelectTriggerVariants,
	selectItemVariants,
	selectTriggerVariants,
} from "./selectVariants";

const Select = SelectPrimitive.Root;

const SelectGroup = SelectPrimitive.Group;

const SelectValue = SelectPrimitive.Value;

type SelectTriggerProps = React.ComponentPropsWithoutRef<
	typeof SelectPrimitive.Trigger
> &
	SelectTriggerVariants;

const SelectTrigger = React.memo(
	React.forwardRef<
		React.ElementRef<typeof SelectPrimitive.Trigger>,
		SelectTriggerProps
	>(
		(
			{ className, children, disabled, style, variant, size, ...props },
			ref,
		) => {
			return (
				<SelectPrimitive.Trigger
					ref={ref}
					disabled={disabled}
					style={style}
					className={cn(selectTriggerVariants({ variant, size }), className)}
					{...props}
				>
					{children}
					<SelectPrimitive.Icon asChild>
						<ChevronDown
							className="h-5 w-5 shrink-0"
							style={{ opacity: 0.5 }}
						/>
					</SelectPrimitive.Icon>
				</SelectPrimitive.Trigger>
			);
		},
	),
);
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectContent = React.memo(
	React.forwardRef<
		React.ElementRef<typeof SelectPrimitive.Content>,
		React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content> & {
			width?: "stretch" | "content";
		}
	>(
		(
			{ className, children, position = "popper", width = "content", ...props },
			ref,
		) => (
			<SelectPrimitive.Portal>
				<SelectPrimitive.Content
					ref={ref}
					position={position}
					className={cn(
						"relative z-50 min-w-[8rem] overflow-hidden rounded-[calc(var(--radius,0.5rem)-2px)] border border-border bg-background text-foreground shadow-md",
						"data-[state=open]:animate-in data-[state=closed]:animate-out",
						"data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
						"data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
						"data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2",
						"data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
						position === "popper" &&
							"data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
						className,
					)}
					{...props}
				>
					<SelectPrimitive.Viewport
						className={cn(
							"p-1",
							"p-1",
							position === "popper" &&
								(width === "stretch"
									? "h-[var(--radix-select-trigger-height)] w-[var(--radix-select-trigger-width)]"
									: "h-[var(--radix-select-trigger-height)] min-w-[var(--radix-select-trigger-width)]"),
						)}
					>
						{children}
					</SelectPrimitive.Viewport>
					<SelectPrimitive.ScrollUpButton className="flex cursor-default items-center justify-center py-2 text-foreground">
						<ChevronUp className="h-5 w-5" />
					</SelectPrimitive.ScrollUpButton>
					<SelectPrimitive.ScrollDownButton className="flex cursor-default items-center justify-center py-2 text-foreground">
						<ChevronDown className="h-5 w-5" />
					</SelectPrimitive.ScrollDownButton>
				</SelectPrimitive.Content>
			</SelectPrimitive.Portal>
		),
	),
);
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectLabel = React.forwardRef<
	React.ElementRef<typeof SelectPrimitive.Label>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className, ...props }, ref) => (
	<SelectPrimitive.Label
		ref={ref}
		className={cn("px-2 py-2 text-ui font-semibold text-foreground", className)}
		{...props}
	/>
));
SelectLabel.displayName = SelectPrimitive.Label.displayName;

const SelectItem = React.memo(
	React.forwardRef<
		React.ElementRef<typeof SelectPrimitive.Item>,
		React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item> &
			SelectItemVariants
	>(({ className, children, size, ...props }, ref) => (
		<SelectPrimitive.Item
			ref={ref}
			className={cn(
				selectItemVariants({
					size,
					indicator: "check",
					padding: "withIndicator",
				}),
				"text-foreground transition-colors",
				className,
			)}
			{...props}
		>
			<span className="absolute left-4 flex h-5 w-5 items-center justify-center">
				<SelectPrimitive.ItemIndicator>
					<Check className="h-4 w-4" />
				</SelectPrimitive.ItemIndicator>
			</span>
			<SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
		</SelectPrimitive.Item>
	)),
);
SelectItem.displayName = SelectPrimitive.Item.displayName;

const SelectSeparator = React.forwardRef<
	React.ElementRef<typeof SelectPrimitive.Separator>,
	React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className, ...props }, ref) => (
	<SelectPrimitive.Separator
		ref={ref}
		className={cn("-mx-1 my-1 h-px bg-border", className)}
		{...props}
	/>
));
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;

export {
	Select,
	SelectGroup,
	SelectValue,
	SelectTrigger,
	SelectContent,
	SelectLabel,
	SelectItem,
	SelectSeparator,
};
