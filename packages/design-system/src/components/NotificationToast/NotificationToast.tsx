import {
	AlertCircle,
	AlertTriangle,
	ArrowRight,
	CheckCircle2,
	Info,
	X,
} from "lucide-react";
import * as React from "react";
import { cn } from "@/utils/cn";

export type NotificationToastType = "info" | "success" | "warning" | "error";

export interface NotificationToastProps
	extends React.HTMLAttributes<HTMLDivElement> {
	type: NotificationToastType;
	title: string;
	message: string;
	linkLabel?: string;
	onClickLink?: () => void;
	onClose?: () => void;
	showCloseButton?: boolean;
}

const borderColorClasses: Record<NotificationToastType, string> = {
	info: "border-l-info",
	success: "border-l-success",
	warning: "border-l-warning",
	error: "border-l-destructive",
};

const typeIcon: Record<
	NotificationToastType,
	React.ComponentType<{ className?: string }>
> = {
	info: Info,
	success: CheckCircle2,
	warning: AlertTriangle,
	error: AlertCircle,
};

const typeIconColor: Record<NotificationToastType, string> = {
	info: "text-info",
	success: "text-success",
	warning: "text-warning",
	error: "text-destructive",
};

export const NotificationToast = React.memo<NotificationToastProps>(
	({
		type,
		title,
		message,
		linkLabel,
		onClickLink,
		onClose,
		showCloseButton = true,
		className,
		...props
	}) => {
		const t = (key: string, fallback?: string) => fallback ?? key;
		const borderColor = borderColorClasses[type];
		const hasLink = typeof onClickLink === "function";
		const Icon = typeIcon[type];

		return (
			<div
				className={cn(
					"relative w-full max-w-sm bg-background shadow-md rounded-lg border border-border border-l-4",
					"pr-[calc(var(--ui-component-padding-x)+5px)] pl-1 py-[calc(var(--ui-component-padding-y)+5px)]",
					borderColor,
					hasLink ? "hover:shadow-lg" : undefined,
					className,
				)}
				role="alert"
				aria-live="polite"
				aria-atomic="true"
				{...props}
			>
				<div className="flex items-start gap-[var(--ui-gap-base)]">
					<div
						className={cn("shrink-0", typeIconColor[type])}
						aria-hidden="true"
					>
						<Icon className="h-4 w-4" />
					</div>

					<div className="flex-1 min-w-0">
						{hasLink ? (
							<button
								type="button"
								className="w-full text-left"
								onClick={onClickLink}
								aria-label={linkLabel ? `${title}. ${linkLabel}` : title}
							>
								<div className="min-w-0">
									<h4 className="text-sm font-bold text-foreground truncate leading-tight">
										{title}
									</h4>
									<p className="text-xs text-muted-foreground break-words leading-tight">
										{message}
									</p>

									<div className="text-xs text-accent-foreground flex items-center gap-1 leading-tight">
										<ArrowRight className="h-3 w-3" />
										<span>{linkLabel || t("details", "詳細を見る")}</span>
									</div>
								</div>
							</button>
						) : (
							<div className="min-w-0">
								<h4 className="text-sm font-bold text-foreground truncate leading-tight">
									{title}
								</h4>
								<p className="text-xs text-muted-foreground break-words leading-tight">
									{message}
								</p>
							</div>
						)}
					</div>
				</div>

				{showCloseButton && (
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							onClose?.();
						}}
						className="absolute top-[5px] right-[5px] flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors p-1"
						aria-label={t("close", "Close")}
					>
						<X className="h-3 w-3" />
					</button>
				)}
			</div>
		);
	},
);

NotificationToast.displayName = "NotificationToast";
