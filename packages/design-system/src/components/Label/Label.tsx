import * as LabelPrimitive from "@radix-ui/react-label";
import * as React from "react";
import { cn } from "@/utils/cn";

export const Label = React.memo(
	React.forwardRef<
		React.ElementRef<typeof LabelPrimitive.Root>,
		React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
	>(({ className, ...props }, ref) => (
		<LabelPrimitive.Root
			ref={ref}
			className={cn(
				"text-ui font-medium leading-none text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70 peer-disabled:text-theme-disabled-text",
				className,
			)}
			{...props}
		/>
	)),
);
Label.displayName = "Label";
