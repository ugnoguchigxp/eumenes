import type React from "react";
import {
	type CSSProperties,
	type ElementType,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

interface AdaptiveTextProps {
	text: string;
	width?: number | string;
	className?: string;
	style?: CSSProperties;
	as?: ElementType;
}

/**
 * AdaptiveText Component
 *
 * Adapts the font size of the text to fit within a specified width.
 * - If text fits: Renders normally.
 * - If text exceeds width by <= 30%: Scales down font size to fit.
 * - If text exceeds width by > 30%: Truncates with ellipsis.
 */
export const AdaptiveText: React.FC<AdaptiveTextProps> = ({
	text,
	width,
	className = "",
	style = {},
	as: Component = "div",
}) => {
	const containerRef = useRef<HTMLElement>(null);
	const textRef = useRef<HTMLSpanElement>(null);
	const [scale, setScale] = useState(1);
	const [isTruncated, setIsTruncated] = useState(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies: text and width changes require re-measurement
	useLayoutEffect(() => {
		const container = containerRef.current;
		const textElement = textRef.current;

		if (!container || !textElement) return;

		const checkSize = () => {
			// Reset state for measurement
			setScale(1);
			setIsTruncated(false);

			// Get available width
			let availableWidth = 0;
			if (typeof width === "number") {
				availableWidth = width;
			} else if (typeof width === "string" && width.endsWith("px")) {
				availableWidth = Number.parseFloat(width);
			} else {
				// If width is not fixed, measure the container's clientWidth
				// We might need to temporarily unset overflow/width constraints to measure true available space
				// depending on how the parent is styled.
				// For now, assume the container has a defined width or is constrained by parent.
				availableWidth = container.clientWidth;
			}

			if (availableWidth <= 0) return;

			// Measure text width
			// We use the scrollWidth of the text span which should be unconstrained
			const textWidth = textElement.scrollWidth;

			const overflowRatio = textWidth / availableWidth;

			if (overflowRatio <= 1.0) {
				// Fits perfectly
				setScale(1);
				setIsTruncated(false);
			} else if (overflowRatio <= 1.3) {
				// Exceeds by up to 30%, scale down
				// We scale to fit exactly: scale = availableWidth / textWidth
				// This is equivalent to 1 / overflowRatio
				setScale(1 / overflowRatio);
				setIsTruncated(false);
			} else {
				// Exceeds by more than 30%, truncate
				setScale(1);
				setIsTruncated(true);
			}
		};

		checkSize();

		// If width is not provided, we might want to observe resize
		if (!width) {
			const resizeObserver = new ResizeObserver(() => {
				checkSize();
			});
			resizeObserver.observe(container);
			return () => resizeObserver.disconnect();
		}
		return undefined; // Explicitly return undefined if no cleanup is needed
	}, [text, width]);

	const combinedStyle: CSSProperties = {
		...style,
		width: width,
		whiteSpace: "nowrap",
		overflow: isTruncated ? "hidden" : "visible",
		textOverflow: isTruncated ? "ellipsis" : "clip",
		display: "block", // Ensure block/inline-block for width to apply
	};

	const textStyle: CSSProperties = {
		display: "inline-block",
		transform: scale < 1 ? `scale(${scale})` : "none",
		transformOrigin: "left center",
		width: scale < 1 ? `${(1 / scale) * 100}%` : "auto", // Compensate width when scaled
	};

	return (
		<Component
			ref={containerRef}
			className={`adaptive-text-container ${className}`}
			style={combinedStyle}
			title={isTruncated ? text : undefined}
		>
			<span ref={textRef} style={textStyle}>
				{text}
			</span>
		</Component>
	);
};
