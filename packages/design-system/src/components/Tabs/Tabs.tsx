import * as TabsPrimitive from "@radix-ui/react-tabs";
import { ArrowLeft, X } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/Button";
import { cn } from "@/utils/cn";

const Tabs = TabsPrimitive.Root;
type TabsVariant = "line" | "workspace";
const TabsVariantContext = React.createContext<TabsVariant>("line");

interface TabsListProps extends React.ComponentPropsWithoutRef<
	typeof TabsPrimitive.List
> {
	variant?: TabsVariant;
	onBack?: () => void;
	backButtonLabel?: string;
}
const TabsList = React.forwardRef<
	React.ElementRef<typeof TabsPrimitive.List>,
	TabsListProps
>(
	(
		{
			className,
			children,
			variant = "line",
			onBack,
			backButtonLabel,
			...props
		},
		ref,
	) => (
		<TabsVariantContext.Provider value={variant}>
			<TabsPrimitive.List
				ref={ref}
				className={cn("ds-tabs-list", className)}
				data-variant={variant}
				{...props}
			>
				{onBack && (
					<Button variant="ghost" size="sm" onClick={onBack}>
						<ArrowLeft className="mr-1 h-4 w-4" />
						{backButtonLabel || "戻る"}
					</Button>
				)}
				{children}
			</TabsPrimitive.List>
		</TabsVariantContext.Provider>
	),
);
TabsList.displayName = TabsPrimitive.List.displayName;

interface TabsTriggerProps extends React.ComponentPropsWithoutRef<
	typeof TabsPrimitive.Trigger
> {
	icon?: React.ElementType;
	onClose?: () => void;
	closeLabel?: string;
}
const TabsTrigger = React.forwardRef<
	React.ElementRef<typeof TabsPrimitive.Trigger>,
	TabsTriggerProps
>(
	(
		{
			className,
			children,
			icon: Icon,
			onClose,
			closeLabel,
			disabled,
			...props
		},
		ref,
	) => {
		const variant = React.useContext(TabsVariantContext);
		return (
			<span className="ds-tabs-item" data-variant={variant}>
				<TabsPrimitive.Trigger
					ref={ref}
					className={cn("ds-tabs-trigger", className)}
					disabled={disabled}
					{...props}
				>
					{Icon && <Icon className="h-4 w-4 shrink-0" />}
					<span
						className="ds-tabs-label"
						title={typeof children === "string" ? children : undefined}
					>
						{children}
					</span>
				</TabsPrimitive.Trigger>
				{onClose && (
					<button
						type="button"
						className="ds-tabs-close"
						aria-label={
							closeLabel ??
							(typeof children === "string"
								? `${children}を閉じる`
								: "タブを閉じる")
						}
						disabled={disabled}
						onClick={onClose}
					>
						<X aria-hidden="true" size={14} />
					</button>
				)}
			</span>
		);
	},
);
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;
const TabsContent = React.forwardRef<
	React.ElementRef<typeof TabsPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
	<TabsPrimitive.Content
		ref={ref}
		className={cn("ds-tabs-content", className)}
		{...props}
	/>
));
TabsContent.displayName = TabsPrimitive.Content.displayName;
export { Tabs, TabsList, TabsTrigger, TabsContent };
export type { TabsVariant, TabsListProps, TabsTriggerProps };
