import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as React from "react";
import { cn } from "@/utils/cn";

export const TooltipProvider = TooltipPrimitive.Provider;

export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = React.memo(
	React.forwardRef<
		React.ElementRef<typeof TooltipPrimitive.Content>,
		React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> & {
			align?: "start" | "center" | "end";
		}
	>(({ className, sideOffset = 4, side = "bottom", ...props }, ref) => (
		<TooltipPrimitive.Content
			ref={ref}
			sideOffset={sideOffset}
			side={side}
			className={cn(
				"z-50 overflow-hidden rounded-md border border-white bg-black text-white px-3 py-1.5 text-xs shadow-md animate-in fade-in-0 zoom-in-95",
				className,
			)}
			{...props}
		/>
	)),
);
TooltipContent.displayName = TooltipPrimitive.Content.displayName;
