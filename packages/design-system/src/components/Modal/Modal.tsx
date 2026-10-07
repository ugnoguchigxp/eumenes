import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";
import { cn } from "@/utils/cn";

interface IModalProps
	extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root> {
	trigger?: React.ReactNode;
	title?: string;
	description?: string;
	footer?: React.ReactNode;
	footerClassName?: string;
	className?: string;
	contentClassName?: string;
	onClose?: () => void;
	noHeader?: boolean;
	noPadding?: boolean;
	draggable?: boolean;
}

const Modal = React.memo(
	React.forwardRef<
		React.ElementRef<typeof DialogPrimitive.Content>,
		IModalProps
	>(
		(
			{
				children,
				trigger,
				title,
				description,
				footer,
				footerClassName,
				className,
				contentClassName,
				open,
				onOpenChange,
				onClose,
				defaultOpen,
				draggable = true,
				...props
			},
			ref,
		) => {
			const [position, setPosition] = React.useState({ x: 0, y: 0 });
			const [isDragging, setIsDragging] = React.useState(false);
			const dragStartPos = React.useRef({ x: 0, y: 0 });

			const [internalOpen, setInternalOpen] = React.useState(
				defaultOpen || false,
			);

			const isControlled = open !== undefined;
			const show = isControlled ? open : internalOpen;

			// Modal閉じた時に位置をリセット
			React.useEffect(() => {
				if (!show) {
					setPosition({ x: 0, y: 0 });
					setIsDragging(false);
				}
			}, [show]);

			const handleOpenChange = (newOpen: boolean) => {
				if (!isControlled) {
					setInternalOpen(newOpen);
				}
				onOpenChange?.(newOpen);
				if (!newOpen && onClose) {
					onClose();
				}
			};

			const handleMouseDown = (e: React.MouseEvent) => {
				if (!draggable) return;
				setIsDragging(true);
				dragStartPos.current = {
					x: e.clientX - position.x,
					y: e.clientY - position.y,
				};
			};

			React.useEffect(() => {
				if (!isDragging) return;

				let animationFrameId: number;

				const handleMouseMove = (e: MouseEvent) => {
					animationFrameId = requestAnimationFrame(() => {
						setPosition({
							x: e.clientX - dragStartPos.current.x,
							y: e.clientY - dragStartPos.current.y,
						});
					});
				};

				const handleMouseUp = () => {
					setIsDragging(false);
				};

				document.addEventListener("mousemove", handleMouseMove);
				document.addEventListener("mouseup", handleMouseUp);

				return () => {
					cancelAnimationFrame(animationFrameId);
					document.removeEventListener("mousemove", handleMouseMove);
					document.removeEventListener("mouseup", handleMouseUp);
				};
			}, [isDragging]);

			const generatedDescriptionId = React.useId();
			const descriptionId = generatedDescriptionId;

			const modalContent = (
				<>
					{!props.noHeader && (
						<div
							data-testid="modal-header"
							className={cn(
								"relative flex flex-col space-y-1.5 border-b border-border bg-card/50 flex-shrink-0",
								draggable && "cursor-move",
								props.noPadding ? "p-1" : "p-[var(--ui-component-padding-y)]",
							)}
						>
							{draggable && (
								<button
									type="button"
									aria-label="Drag modal"
									className="absolute inset-0 cursor-move"
									onMouseDown={handleMouseDown}
								/>
							)}
							<div className="relative z-10 w-full">
								<div className="flex items-center justify-between">
									<DialogPrimitive.Title
										className={cn(
											"text-lg font-semibold leading-none tracking-tight text-foreground",
											!title && "sr-only",
										)}
									>
										{title || "Dialog"}
									</DialogPrimitive.Title>
									<DialogPrimitive.Close className="rounded-full p-1 opacity-70 ring-offset-background transition-all hover:opacity-100 hover:bg-accent focus:outline-none disabled:pointer-events-none cursor-pointer">
										<X className="h-5 w-5 text-foreground" />
										<span className="sr-only">Close</span>
									</DialogPrimitive.Close>
								</div>
								{description ? (
									<DialogPrimitive.Description
										id={descriptionId}
										className="text-sm text-muted-foreground mt-1.5"
									>
										{description}
									</DialogPrimitive.Description>
								) : (
									<DialogPrimitive.Description
										id={descriptionId}
										className="sr-only"
									>
										Dialog Content
									</DialogPrimitive.Description>
								)}
							</div>
						</div>
					)}
					{/* Always render hidden description if header is disabled to satisfy accessibility requirements */}
					{props.noHeader && (
						<DialogPrimitive.Description id={descriptionId} className="sr-only">
							Dialog Content
						</DialogPrimitive.Description>
					)}

					<div
						className={cn(
							"flex-1 overflow-y-auto",
							props.noPadding ? "p-0" : "p-[var(--ui-modal-padding)]",
							contentClassName,
						)}
					>
						{children}
					</div>

					{footer && (
						<div
							className={cn(
								"flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2 bg-background flex-shrink-0",
								"p-[var(--ui-component-padding-y)]",
								footerClassName,
							)}
						>
							{footer}
						</div>
					)}
				</>
			);

			return (
				<DialogPrimitive.Root
					open={show}
					onOpenChange={handleOpenChange}
					{...props}
				>
					{trigger && (
						<DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>
					)}
					<DialogPrimitive.Portal>
						<DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
						<DialogPrimitive.Content
							ref={ref}
							aria-describedby={descriptionId}
							className={cn(
								"fixed z-50 flex flex-col gap-0 bg-background",
								!draggable && "duration-200",
								!draggable &&
									"data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
								!draggable &&
									"bottom-0 left-0 right-0 w-full h-[90vh] rounded-t-xl border-t border-border",
								!draggable &&
									"data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
								draggable &&
									"left-[50%] top-[50%] h-auto max-h-[90vh] w-[90vw] max-w-lg rounded-md border border-border",
								!draggable &&
									"sm:left-[50%] sm:top-[50%] sm:bottom-auto sm:right-auto sm:h-auto sm:max-h-[90vh] sm:max-w-lg sm:rounded-md sm:border sm:border-border",
								!draggable &&
									"sm:data-[state=closed]:zoom-out-95 sm:data-[state=open]:zoom-in-95",
								!draggable &&
									"sm:data-[state=closed]:slide-out-to-left-1/2 sm:data-[state=closed]:slide-out-to-top-[48%]",
								!draggable &&
									"sm:data-[state=open]:slide-in-from-left-1/2 sm:data-[state=open]:slide-in-from-top-[48%]",
								className,
							)}
							style={
								draggable
									? {
											transform: `translate(calc(-50% + ${position.x}px), calc(-50% + ${position.y}px))`,
											cursor: isDragging ? "grabbing" : undefined,
										}
									: {
											transform: "translate(-50%, -50%)",
										}
							}
						>
							{modalContent}
						</DialogPrimitive.Content>
					</DialogPrimitive.Portal>
				</DialogPrimitive.Root>
			);
		},
	),
);

Modal.displayName = "Modal";

// ModalFooter component for consistent footer styling
export const ModalFooter: React.FC<{
	children: React.ReactNode;
	className?: string;
}> = ({ children, className }) => {
	return (
		<div
			className={cn(
				"flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2 gap-2 bg-background flex-shrink-0 p-[var(--ui-component-padding-y)]",
				className,
			)}
		>
			{children}
		</div>
	);
};

ModalFooter.displayName = "ModalFooter";

export { Modal };
export default Modal;
