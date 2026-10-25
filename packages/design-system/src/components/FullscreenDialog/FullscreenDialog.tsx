import * as Dialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "../Button";
import "./FullscreenDialog.css";
export type FullscreenDialogProps = {
	open: boolean;
	title: string;
	closeLabel?: string;
	onOpenChange: (open: boolean) => void;
	onCloseAutoFocus?: (event: Event) => void;
	children: ReactNode;
};
/** A reusable viewport workspace with modal focus, Escape and scroll containment. */
export function FullscreenDialog({
	open,
	title,
	closeLabel = "閉じる",
	onOpenChange,
	onCloseAutoFocus,
	children,
}: FullscreenDialogProps) {
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="fullscreen-dialog-overlay" />
				<Dialog.Content
					className="fullscreen-dialog"
					aria-describedby={undefined}
					onCloseAutoFocus={onCloseAutoFocus}
				>
					<Dialog.Title className="fullscreen-dialog-title">
						{title}
					</Dialog.Title>
					<Dialog.Close asChild>
						<Button
							className="fullscreen-dialog-close"
							variant="ghost"
							size="icon"
							aria-label={closeLabel}
						>
							<X aria-hidden="true" />
						</Button>
					</Dialog.Close>
					<div className="fullscreen-dialog-body">{children}</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
