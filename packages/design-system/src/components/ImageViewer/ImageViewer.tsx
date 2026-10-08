import React, { useEffect, useRef } from "react";
// Shadcn components (assumed existing in project)
import { Modal } from "@/components/Modal"; // lightweight local implementation
import { cn } from "@/utils/cn";

interface IImageViewerProps {
	src: string;
	alt?: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Optional max width for large images */
	maxWidthPx?: number;
}

/** Responsive image viewer using shadcn dialog */
export const ImageViewer: React.FC<IImageViewerProps> = React.memo(
	({ src, alt, open, onOpenChange, maxWidthPx = 900 }) => {
		const imgRef = useRef<HTMLImageElement | null>(null);

		// Keep the controlled viewer in sync with Escape.
		useEffect(() => {
			const handleKey = (e: KeyboardEvent) => {
				if (e.key === "Escape" && open) {
					onOpenChange(false);
				}
			};
			window.addEventListener("keydown", handleKey);
			return () => window.removeEventListener("keydown", handleKey);
		}, [open, onOpenChange]);

		return (
			<Modal
				open={open}
				onOpenChange={onOpenChange}
				noHeader
				noPadding
				contentClassName="bg-black/90 border border-black/40 shadow-xl focus:outline-none flex items-center justify-center max-h-[90vh]"
				className="p-2 md:p-4 bg-transparent border-none shadow-none"
			>
				<div className="w-full h-full flex items-center justify-center">
					<img
						ref={imgRef}
						src={src || undefined}
						alt={alt || "Image"}
						className={cn(
							"rounded-md object-contain shadow-lg",
							"max-h-[80vh] w-auto",
							"transition-opacity duration-200",
						)}
						style={{ maxWidth: `${maxWidthPx}px` }}
					/>
				</div>
			</Modal>
		);
	},
);

interface IUseImageViewerResult {
	open: boolean;
	show: (src: string, alt?: string) => void;
	hide: () => void;
	src: string | null;
	alt: string | undefined;
}

/** Hook to manage image viewer state */
export const useImageViewer = (): IUseImageViewerResult => {
	const [open, setOpen] = React.useState(false);
	const [src, setSrc] = React.useState<string | null>(null);
	const [alt, setAlt] = React.useState<string | undefined>(undefined);

	const show = (newSrc: string, newAlt?: string) => {
		setSrc(newSrc);
		setAlt(newAlt);
		setOpen(true);
	};
	const hide = () => setOpen(false);

	return { open, show, hide, src, alt };
};

/**
 * Image with preview capability
 * Displays a thumbnail that opens the full-screen viewer on click
 */
interface IImageWithPreviewProps {
	src: string;
	alt?: string;
	className?: string;
	width?: string | number;
	height?: string | number;
	children?: React.ReactNode;
}

export const ImageWithPreview: React.FC<IImageWithPreviewProps> = ({
	src,
	alt,
	className,
	width,
	height,
	children,
}) => {
	const [open, setOpen] = React.useState(false);
	const label = alt || "Image";

	return (
		<>
			<button
				type="button"
				className={cn("cursor-pointer border-0 bg-transparent p-0", className)}
				aria-label={label}
				onClick={(e) => {
					e.stopPropagation();
					setOpen(true);
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						setOpen(true);
					}
				}}
				style={{ width, height }}
			>
				{children || (
					<img
						src={src || undefined}
						alt={alt || "Image"}
						className="w-full h-full object-cover"
					/>
				)}
			</button>

			<ImageViewer
				src={src}
				alt={alt}
				open={open}
				onOpenChange={setOpen}
			/>
		</>
	);
};
