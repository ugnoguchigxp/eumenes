import {
	type CSSProperties,
	type KeyboardEvent,
	type PointerEvent,
	useEffect,
	useRef,
} from "react";
import { cn } from "../../utils/cn";
import "./Canvas2D.css";

/** The visible rectangle in the caller's world coordinates. */
export type CanvasViewport = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export type CanvasFrame = {
	viewport: CanvasViewport;
	elapsedMs: number;
	deltaMs: number;
};

export type CanvasPointer = {
	type: "down" | "move" | "up" | "cancel";
	x: number;
	y: number;
	inside: boolean;
	buttons: number;
	pointerId: number;
};

export type Canvas2DProps = {
	viewport: CanvasViewport;
	/** Receives a cleared, clipped context transformed into world coordinates. */
	draw: (context: CanvasRenderingContext2D, frame: CanvasFrame) => void;
	ariaLabel: string;
	/** Request frames continuously. Static scenes redraw when props or size change. */
	playing?: boolean;
	/** Nearest-neighbor scaling for pixel art. */
	pixelated?: boolean;
	/** Multiplier for the device pixel ratio; defaults to 1. */
	resolutionScale?: number;
	onPointer?: (pointer: CanvasPointer) => void;
	onKeyDown?: (event: KeyboardEvent<HTMLCanvasElement>) => void;
	onKeyUp?: (event: KeyboardEvent<HTMLCanvasElement>) => void;
	className?: string;
	style?: CSSProperties;
};

function isValidViewport(viewport: CanvasViewport) {
	return (
		Number.isFinite(viewport.x) &&
		Number.isFinite(viewport.y) &&
		Number.isFinite(viewport.width) &&
		Number.isFinite(viewport.height) &&
		viewport.width > 0 &&
		viewport.height > 0
	);
}

export function Canvas2D({
	viewport,
	draw,
	ariaLabel,
	playing = false,
	pixelated = false,
	resolutionScale = 1,
	onPointer,
	onKeyDown,
	onKeyUp,
	className,
	style,
}: Canvas2DProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const viewportRef = useRef(viewport);
	const drawRef = useRef(draw);
	useEffect(() => {
		viewportRef.current = viewport;
		drawRef.current = draw;
	});
	const refreshRef = useRef<() => void>(() => {});
	const elapsedRef = useRef(0);
	const lastRef = useRef<number | null>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const context = canvas.getContext("2d");
		if (!context) return;
		let frameId = 0;
		let stopped = false;
		const paint = (time: number) => {
			if (stopped || document.hidden) return false;
			const rect = canvas.getBoundingClientRect();
			const current = viewportRef.current;
			if (rect.width <= 0 || rect.height <= 0 || !isValidViewport(current))
				return false;
			const multiplier =
				Number.isFinite(resolutionScale) && resolutionScale > 0
					? resolutionScale
					: 1;
			const density = Math.max(
				0.1,
				(window.devicePixelRatio || 1) * multiplier,
			);
			const pixelWidth = Math.max(1, Math.round(rect.width * density));
			const pixelHeight = Math.max(1, Math.round(rect.height * density));
			if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
			if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
			const scale = Math.min(
				pixelWidth / current.width,
				pixelHeight / current.height,
			);
			const offsetX = (pixelWidth - current.width * scale) / 2;
			const offsetY = (pixelHeight - current.height * scale) / 2;
			context.setTransform(1, 0, 0, 1, 0, 0);
			context.clearRect(0, 0, pixelWidth, pixelHeight);
			context.save();
			context.beginPath();
			context.rect(
				offsetX,
				offsetY,
				current.width * scale,
				current.height * scale,
			);
			context.clip();
			context.setTransform(
				scale,
				0,
				0,
				scale,
				offsetX - current.x * scale,
				offsetY - current.y * scale,
			);
			const deltaMs = lastRef.current === null ? 0 : time - lastRef.current;
			lastRef.current = time;
			elapsedRef.current += deltaMs;
			try {
				drawRef.current(context, {
					viewport: current,
					elapsedMs: elapsedRef.current,
					deltaMs,
				});
			} finally {
				context.restore();
			}
			return true;
		};
		const tick = (time: number) => {
			const visible = paint(time);
			if (!stopped && playing && visible) frameId = requestAnimationFrame(tick);
		};
		const refresh = () => {
			cancelAnimationFrame(frameId);
			lastRef.current = null;
			if (!document.hidden) frameId = requestAnimationFrame(tick);
		};
		refreshRef.current = refresh;
		const observer = new ResizeObserver(refresh);
		observer.observe(canvas);
		document.addEventListener("visibilitychange", refresh);
		window.addEventListener("resize", refresh);
		refresh();
		return () => {
			stopped = true;
			refreshRef.current = () => {};
			cancelAnimationFrame(frameId);
			observer.disconnect();
			document.removeEventListener("visibilitychange", refresh);
			window.removeEventListener("resize", refresh);
		};
	}, [playing, resolutionScale]);

	useEffect(() => {
		if (playing || document.hidden) return;
		// A new scene or camera position must repaint even without an animation loop.
		refreshRef.current();
	});

	function handlePointer(
		type: CanvasPointer["type"],
		event: PointerEvent<HTMLCanvasElement>,
	) {
		if (type === "down" && (onPointer || onKeyDown || onKeyUp))
			event.currentTarget.focus();
		if (!onPointer || !isValidViewport(viewport)) return;
		const rect = event.currentTarget.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;
		const scale = Math.min(
			rect.width / viewport.width,
			rect.height / viewport.height,
		);
		const offsetX = (rect.width - viewport.width * scale) / 2;
		const offsetY = (rect.height - viewport.height * scale) / 2;
		const x = viewport.x + (event.clientX - rect.left - offsetX) / scale;
		const y = viewport.y + (event.clientY - rect.top - offsetY) / scale;
		if (type === "down") {
			event.currentTarget.setPointerCapture?.(event.pointerId);
		}
		onPointer({
			type,
			x,
			y,
			inside:
				x >= viewport.x &&
				x < viewport.x + viewport.width &&
				y >= viewport.y &&
				y < viewport.y + viewport.height,
			buttons: event.buttons,
			pointerId: event.pointerId,
		});
	}

	const interactive = Boolean(onPointer || onKeyDown || onKeyUp);
	const aspectRatio = isValidViewport(viewport)
		? `${viewport.width} / ${viewport.height}`
		: "1";
	return (
		<canvas
			ref={canvasRef}
			className={cn(
				"ds-canvas-2d",
				pixelated && "ds-canvas-2d-pixelated",
				onPointer && "ds-canvas-2d-pointer",
				className,
			)}
			style={{ aspectRatio, ...style }}
			role={interactive ? "application" : "img"}
			aria-label={ariaLabel}
			tabIndex={interactive ? 0 : undefined}
			onPointerDown={(event) => handlePointer("down", event)}
			onPointerMove={(event) => handlePointer("move", event)}
			onPointerUp={(event) => handlePointer("up", event)}
			onPointerCancel={(event) => handlePointer("cancel", event)}
			onKeyDown={onKeyDown}
			onKeyUp={onKeyUp}
		/>
	);
}
