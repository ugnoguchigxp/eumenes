import { MessageCircle, X } from "lucide-react";
import * as React from "react";

import { cn } from "@/utils/cn";

export interface ChatDockProps {
	isOpen: boolean;
	onOpen: () => void;
	onClose: () => void;
	title?: string;
	buttonLabel?: string;
	children?: React.ReactNode;
	className?: string;
	panelClassName?: string;
	bodyClassName?: string;
	buttonClassName?: string;
	footer?: React.ReactNode;
	footerClassName?: string;
	bodyRef?: React.Ref<HTMLDivElement>;
}

export const ChatDock: React.FC<ChatDockProps> = React.memo(
	({
		isOpen,
		onOpen,
		onClose,
		title = "chatbot",
		buttonLabel = "Chatbot",
		children,
		className,
		panelClassName,
		bodyClassName,

		buttonClassName,
		footer,
		footerClassName,
		bodyRef,
	}) => {
		return (
			<div
				className={cn(
					"fixed bottom-4 right-4 z-50 flex flex-col items-end gap-3",
					className,
				)}
			>
				{isOpen && (
					<div
						className={cn(
							"flex w-[320px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-border/70 bg-background shadow-[0_18px_40px_rgba(15,23,42,0.22)]",
							panelClassName,
						)}
					>
						<div className="flex items-center justify-between border-b border-border/60 bg-muted/40 px-4 py-3">
							<div className="text-sm font-semibold text-foreground">
								{title}
							</div>
							<button
								type="button"
								onClick={onClose}
								className="rounded-full border border-border/70 bg-background/80 p-1 text-muted-foreground transition hover:text-foreground"
								aria-label="チャットを閉じる"
							>
								<X className="h-4 w-4" />
							</button>
						</div>
						<div
							ref={bodyRef}
							className={cn("flex-1 overflow-y-auto px-4 py-3", bodyClassName)}
						>
							{children}
							{footer && (
								<div
									className={cn(
										"mt-4 -mx-4 border-t border-border/60 bg-background/50 p-4 backdrop-blur supports-[backdrop-filter]:bg-background/50",
										footerClassName,
									)}
								>
									{footer}
								</div>
							)}
						</div>
					</div>
				)}

				<button
					type="button"
					onClick={isOpen ? onClose : onOpen}
					className={cn(
						"inline-flex items-center gap-2 rounded-full border border-border/70 bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-[0_12px_28px_rgba(15,23,42,0.25)] transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
						buttonClassName,
					)}
					aria-expanded={isOpen}
					aria-label="チャットを開閉"
				>
					<MessageCircle className="h-4 w-4" />
					{buttonLabel}
				</button>
			</div>
		);
	},
);

export default ChatDock;
