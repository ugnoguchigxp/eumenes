/* istanbul ignore file */
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { ArrowLeft } from "lucide-react";
import * as React from "react";
import { AdaptiveText } from "@/components/AdaptiveText";
import { Button } from "@/components/Button";
import { cn } from "@/utils/cn";

const Tabs = TabsPrimitive.Root;

interface TabsListProps
	extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> {
	onBack?: () => void;
	backButtonLabel?: string;
}

const TabsList = React.forwardRef<
	React.ElementRef<typeof TabsPrimitive.List>,
	TabsListProps
>(({ className, children, onBack, backButtonLabel, ...props }, ref) => (
	<TabsPrimitive.List
		ref={ref}
		className={cn(
			"inline-flex items-center justify-start rounded-md bg-card text-foreground",
			"w-full h-auto p-1 flex flex-wrap gap-1",
			className,
		)}
		{...props}
	>
		{onBack && (
			<Button
				variant="ghost"
				size="sm"
				className="mr-1 h-8 text-muted-foreground hover:text-foreground shrink-0"
				onClick={onBack}
			>
				<ArrowLeft className="mr-1 h-4 w-4" />
				{backButtonLabel || "戻る"}
			</Button>
		)}
		{children}
	</TabsPrimitive.List>
));
TabsList.displayName = TabsPrimitive.List.displayName;

interface TabsTriggerProps
	extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> {
	icon?: React.ElementType;
}

const TabsTrigger = React.forwardRef<
	React.ElementRef<typeof TabsPrimitive.Trigger>,
	TabsTriggerProps
>(({ className, children, icon: Icon, ...props }, ref) => (
	<TabsPrimitive.Trigger
		ref={ref}
		className={cn(
			"inline-flex items-center justify-center whitespace-nowrap rounded-sm px-ui-x py-ui text-ui font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
			"text-muted-foreground min-h-ui-touch border-b-2 border-transparent",
			"data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:font-bold data-[state=active]:shadow-sm data-[state=active]:border-theme-accent",
			"flex-1 md:flex-1 flex gap-2 min-w-[120px] max-w-full overflow-hidden",
			className,
		)}
		{...props}
	>
		{Icon && <Icon className="h-4 w-4 flex-shrink-0" />}
		{typeof children === "string" ? (
			<AdaptiveText
				text={children.length > 10 ? `${children.slice(0, 10)}...` : children}
				className="flex-1 min-w-0 overflow-hidden"
				as="span"
			/>
		) : (
			children
		)}
	</TabsPrimitive.Trigger>
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
	React.ElementRef<typeof TabsPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
	<TabsPrimitive.Content
		ref={ref}
		className={cn(
			"mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
			className,
		)}
		{...props}
	/>
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
