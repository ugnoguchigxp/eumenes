/**
 * Drawer Component
 * Radix UI Dialog-based drawer component
 * Directly implements Radix Dialog to support UI density variables
 */

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import * as React from "react";

import { cn } from "@/utils/cn";

const drawerVariants = cva(
	"fixed z-50 gap-[var(--ui-gap-base)] bg-background p-[var(--ui-modal-padding)] shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-300 data-[state=open]:duration-500",
	{
		variants: {
			side: {
				top: "inset-x-0 top-0 border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
				bottom:
					"inset-x-0 bottom-0 border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
				left: "inset-y-0 left-0 h-full w-3/4 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm",
				right:
					"inset-y-0 right-0 h-full w-3/4 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm",
			},
		},
		defaultVariants: {
			side: "right",
		},
	},
);

export interface DrawerProps extends VariantProps<typeof drawerVariants> {
	isOpen: boolean;
	onClose: () => void;
	children?: React.ReactNode;
	position?: "top" | "bottom" | "left" | "right";
	width?: string;
	noPadding?: boolean;
	title?: string;
	description?: string;
	className?: string;
	trigger?: React.ReactNode;
	overlayClassName?: string;
	closeLabel?: string;
}

export const Drawer: React.FC<DrawerProps> = React.memo(
	({
		isOpen,
		onClose,
		children,
		position = "right",
		noPadding = false,
		title,
		description,
		className,
		width,
		trigger,
		overlayClassName,
		closeLabel = "Close",
	}) => {
		return (
			<DialogPrimitive.Root
				open={isOpen}
				onOpenChange={(open) => !open && onClose()}
			>
				{trigger && (
					<DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>
				)}
				<DialogPrimitive.Portal>
					<DialogPrimitive.Overlay
						className={cn(
							"fixed inset-0 z-50 bg-black/40 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
							overlayClassName,
						)}
					/>
					<DialogPrimitive.Content
						className={cn(
							drawerVariants({ side: position }),
							noPadding && "p-0",
							className,
						)}
						style={width ? { width, maxWidth: "100vw" } : undefined}
					>
						<div
							className={cn(
								"flex flex-col space-y-2 text-center sm:text-left",
								noPadding ? "px-6 pt-6 mb-4" : "mb-4",
							)}
						>
							<DialogPrimitive.Title
								className={cn(
									"text-lg font-semibold text-foreground",
									!title && "sr-only",
								)}
							>
								{title || "Drawer"}
							</DialogPrimitive.Title>
							{description && (
								<DialogPrimitive.Description className="text-sm text-muted-foreground">
									{description}
								</DialogPrimitive.Description>
							)}
						</div>

						<div className="flex-1 overflow-y-auto -mx-[var(--ui-modal-padding)] px-[var(--ui-modal-padding)]">
							{children}
						</div>

						<DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-secondary">
							<X className="h-4 w-4" />
							<span className="sr-only">{closeLabel}</span>
						</DialogPrimitive.Close>
					</DialogPrimitive.Content>
				</DialogPrimitive.Portal>
			</DialogPrimitive.Root>
		);
	},
);

export default Drawer;
