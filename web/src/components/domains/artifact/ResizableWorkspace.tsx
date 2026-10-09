import {
	useEffect,
	useRef,
	useState,
	type CSSProperties,
	type ReactNode,
} from "react";
import "./ResizableWorkspace.css";

const stackedQuery = "(max-width: 900px)";
const clamp = (value: number) => Math.min(75, Math.max(25, value));

export function ResizableWorkspace({
	children,
	artifact,
	hidden,
}: {
	children: ReactNode;
	artifact: ReactNode;
	hidden?: boolean;
}) {
	const container = useRef<HTMLDivElement>(null);
	const drag = useRef<{
		pointerId: number;
		start: number;
		size: number;
		share: number;
	} | null>(null);
	const [stacked, setStacked] = useState(
		() => window.matchMedia(stackedQuery).matches,
	);
	const [shares, setShares] = useState({ horizontal: 50, vertical: 50 });
	const [dragging, setDragging] = useState(false);
	const axis = stacked ? "vertical" : "horizontal";
	const share = shares[axis];
	const split = Boolean(artifact);
	const changeShare = (value: number) =>
		setShares((current) => ({ ...current, [axis]: clamp(value) }));
	const stopDrag = () => {
		drag.current = null;
		setDragging(false);
	};

	useEffect(() => {
		const media = window.matchMedia(stackedQuery);
		const update = () => {
			setStacked(media.matches);
			drag.current = null;
			setDragging(false);
		};
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);

	return (
		<div
			ref={container}
			className={`workspace-layout${split ? " workspace-layout-split" : ""}`}
			hidden={hidden}
			data-resizing={(split && !hidden && dragging) || undefined}
			style={
				{
					"--workspace-chat-size": `${share}fr`,
					"--workspace-artifact-size": `${100 - share}fr`,
				} as CSSProperties
			}
		>
			{children}
			{split && (
				<div
					className="workspace-resize-handle"
					// A focusable splitter is an interactive separator, not a thematic break.
					// oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
					role="separator"
					tabIndex={0}
					aria-label="会話とアーティファクトのサイズを調整"
					aria-orientation={stacked ? "horizontal" : "vertical"}
					aria-valuemin={25}
					aria-valuemax={75}
					aria-valuenow={Math.round(share)}
					aria-valuetext={`会話 ${Math.round(share)}%、アーティファクト ${Math.round(100 - share)}%`}
					onPointerDown={(event) => {
						if (event.button !== 0 || !event.isPrimary || !container.current)
							return;
						const bounds = container.current.getBoundingClientRect();
						const handle = event.currentTarget.getBoundingClientRect();
						const size = stacked
							? bounds.height - handle.height
							: bounds.width - handle.width;
						if (size <= 0) return;
						event.preventDefault();
						event.currentTarget.focus();
						event.currentTarget.setPointerCapture(event.pointerId);
						drag.current = {
							pointerId: event.pointerId,
							start: stacked ? event.clientY : event.clientX,
							size,
							share,
						};
						setDragging(true);
					}}
					onPointerMove={(event) => {
						const current = drag.current;
						if (!current || current.pointerId !== event.pointerId) return;
						const position = stacked ? event.clientY : event.clientX;
						changeShare(
							current.share + ((position - current.start) / current.size) * 100,
						);
					}}
					onPointerUp={stopDrag}
					onPointerCancel={stopDrag}
					onLostPointerCapture={stopDrag}
					onDoubleClick={() => changeShare(50)}
					onKeyDown={(event) => {
						const step = event.shiftKey ? 10 : 2;
						const decrease = stacked ? "ArrowUp" : "ArrowLeft";
						const increase = stacked ? "ArrowDown" : "ArrowRight";
						if (
							![decrease, increase, "Home", "End", "Enter"].includes(event.key)
						)
							return;
						event.preventDefault();
						if (event.key === "Home") changeShare(25);
						else if (event.key === "End") changeShare(75);
						else if (event.key === "Enter") changeShare(50);
						else changeShare(share + (event.key === increase ? step : -step));
					}}
				/>
			)}
			{artifact}
		</div>
	);
}
