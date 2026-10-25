import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Button } from "../Button";
import { FullscreenDialog } from "../FullscreenDialog";
import { ocrRegionBounds, type OcrRegion } from "./region";
import type { OcrWorkspaceProps, OcrRecord } from "./types";
import "./preview.css";

type PreviewProps = OcrWorkspaceProps & {
	item: OcrRecord;
	width: number;
	height: number;
};
function Stage(
	props: PreviewProps & {
		selecting: boolean;
		scale: number;
		scrollRef: React.RefObject<HTMLDivElement | null>;
		baseWidth?: number;
		expanded: boolean;
	},
) {
	const { item, width, height, selecting } = props;
	const video = useRef<HTMLVideoElement>(null);
	const svg = useRef<SVGSVGElement>(null);
	const [draft, setDraft] = useState<OcrRegion>();
	const drag = useRef<
		| {
				point: [number, number];
				original?: OcrRegion;
				handle: string;
				scrollLeft: number;
				scrollTop: number;
				clientX: number;
				clientY: number;
		  }
		| undefined
	>(undefined);
	const frame =
		item.result?.kind === "video"
			? item.result.frames[props.frameIndex]
			: undefined;
	const lines =
		item.result?.kind === "image" ? item.result.lines : (frame?.lines ?? []);
	const region = draft ?? props.selectionRegion;
	useEffect(() => {
		if (video.current && frame)
			video.current.currentTime = frame.timestampSeconds;
	}, [frame]);
	function point(e: PointerEvent): [number, number] | undefined {
		const matrix = svg.current?.getScreenCTM();
		if (!matrix) return;
		const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(
			matrix.inverse(),
		);
		return [
			Math.max(0, Math.min(width, p.x)),
			Math.max(0, Math.min(height, p.y)),
		];
	}
	function start(e: PointerEvent<SVGSVGElement>) {
		if (!selecting && !(props.scale > 1)) return;
		const p = point(e);
		if (!p) return;
		e.preventDefault();
		e.currentTarget.setPointerCapture(e.pointerId);
		const handle = selecting
			? ((e.target as SVGElement).dataset.handle ?? "new")
			: "pan";
		drag.current = {
			point: p,
			original: region,
			handle,
			scrollLeft: props.scrollRef.current?.scrollLeft ?? 0,
			scrollTop: props.scrollRef.current?.scrollTop ?? 0,
			clientX: e.clientX,
			clientY: e.clientY,
		};
		if (handle === "new") setDraft([p[0], p[1], 1, 1]);
	}
	function move(e: PointerEvent<SVGSVGElement>) {
		const d = drag.current;
		const p = point(e);
		if (!d || !p) return;
		if (d.handle === "pan") {
			props.scrollRef.current?.scrollTo(
				d.scrollLeft - e.clientX + d.clientX,
				d.scrollTop - e.clientY + d.clientY,
			);
			return;
		}
		let a = d.point,
			b = p;
		if (d.original && d.handle !== "new") {
			const [x, y, w, h] = d.original;
			if (d.handle === "move") {
				setDraft([
					Math.max(0, Math.min(width - w, x + p[0] - d.point[0])),
					Math.max(0, Math.min(height - h, y + p[1] - d.point[1])),
					w,
					h,
				]);
				return;
			}
			a = [
				d.handle.includes("w") ? x + w : x,
				d.handle.includes("n") ? y + h : y,
			];
			b = p;
		}
		setDraft([
			Math.min(a[0], b[0]),
			Math.min(a[1], b[1]),
			Math.max(1, Math.abs(a[0] - b[0])),
			Math.max(1, Math.abs(a[1] - b[1])),
		]);
	}
	function finish(cancelled: boolean) {
		if (drag.current?.handle !== "pan" && !cancelled && draft)
			props.onRegion?.(draft);
		drag.current = undefined;
		setDraft(undefined);
	}
	return (
		<div
			className="ocr-stage"
			style={{
				width: props.baseWidth
					? `${props.scale * props.baseWidth}px`
					: `${props.scale * 100}%`,
				aspectRatio: `${width}/${height}`,
			}}
		>
			{item.mime.startsWith("image/") ? (
				<img
					src={props.mediaUrl}
					alt={`${item.name}の原本`}
					draggable={false}
				/>
			) : (
				<video
					controls={!props.expanded && !selecting}
					ref={video}
					src={props.mediaUrl}
					muted
					playsInline
					preload="auto"
					onLoadedMetadata={() => {
						if (video.current && frame)
							video.current.currentTime = frame.timestampSeconds;
					}}
					aria-label={`${item.name}の選択フレーム`}
				/>
			)}
			<svg
				ref={svg}
				viewBox={`0 0 ${width} ${height}`}
				aria-label="文字の検出位置"
				className={selecting || props.scale > 1 ? "ocr-stage-interactive" : ""}
				onPointerDown={start}
				onPointerMove={move}
				onPointerUp={() => finish(false)}
				onPointerCancel={() => finish(true)}
			>
				{lines.map((line, index) => (
					<polygon
						key={index}
						points={line.polygon.map((p) => p.join(",")).join(" ")}
						className={
							props.selectedLines.includes(index)
								? "ocr-polygon selected"
								: "ocr-polygon"
						}
						onClick={() => {
							if (!selecting && props.scale === 1) props.onLine?.(index);
						}}
					/>
				))}
				{props.highlightRegion && (
					<rect
						x={props.highlightRegion[0]}
						y={props.highlightRegion[1]}
						width={props.highlightRegion[2]}
						height={props.highlightRegion[3]}
						className="ocr-correction-region"
					/>
				)}
				{region && (
					<g>
						<rect
							x={region[0]}
							y={region[1]}
							width={region[2]}
							height={region[3]}
							className="ocr-selection-region"
							data-handle="move"
						/>
						{selecting &&
							["nw", "ne", "sw", "se"].map((handle) => (
								<circle
									key={handle}
									data-handle={handle}
									cx={region[0] + (handle.includes("e") ? region[2] : 0)}
									cy={region[1] + (handle.includes("s") ? region[3] : 0)}
									r={Math.max(width, height) / 70 / props.scale}
									className="ocr-region-handle"
								/>
							))}
					</g>
				)}
			</svg>
		</div>
	);
}

export function OcrPreview(props: PreviewProps) {
	const [open, setOpen] = useState(false),
		[selecting, setSelecting] = useState(false),
		[scale, setScale] = useState(1);
	const scrollRef = useRef<HTMLDivElement>(null);
	const openButton = useRef<HTMLButtonElement>(null);
	const [baseWidth, setBaseWidth] = useState<number>();
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const update = () =>
			setBaseWidth(
				open
					? Math.min(
							el.clientWidth,
							(el.clientHeight * props.width) / props.height,
						)
					: el.clientWidth,
			);
		update();
		const observer = new ResizeObserver(update);
		observer.observe(el);
		return () => observer.disconnect();
	}, [open, props.width, props.height]);
	const frame =
		props.item.result?.kind === "video"
			? props.item.result.frames[props.frameIndex]
			: undefined;
	const lines =
		props.item.result?.kind === "image"
			? props.item.result.lines
			: (frame?.lines ?? []);
	const target =
		props.selectionRegion ??
		props.highlightRegion ??
		ocrRegionBounds(
			lines
				.filter((_, i) => props.selectedLines.includes(i))
				.flatMap((l) => l.polygon),
		);
	function fit(region?: OcrRegion) {
		const scroller = scrollRef.current;
		if (!scroller) return;
		if (!region) {
			setScale(1);
			scroller.scrollTo(0, 0);
			return;
		}
		const base = (baseWidth ?? scroller.clientWidth) / props.width;
		const next = Math.max(
			1,
			Math.min(
				20,
				(Math.min(
					scroller.clientWidth / region[2],
					scroller.clientHeight / region[3],
				) /
					base) *
					0.85,
			),
		);
		setScale(next);
		requestAnimationFrame(() => {
			const stage = scroller.querySelector<HTMLElement>(".ocr-stage");
			if (stage)
				scroller.scrollTo(
					((region[0] + region[2] / 2) / props.width) * stage.clientWidth -
						scroller.clientWidth / 2,
					((region[1] + region[3] / 2) / props.height) * stage.clientHeight -
						scroller.clientHeight / 2,
				);
		});
	}
	const controls = (
		<div className="ocr-preview-tools">
			<Button
				size="sm"
				variant="outline"
				aria-pressed={selecting}
				onClick={() => setSelecting((v) => !v)}
			>
				範囲を選ぶ
			</Button>
			{props.selectionRegion && (
				<Button
					size="sm"
					variant="ghost"
					onClick={() => props.onRegion?.(undefined)}
				>
					範囲を解除
				</Button>
			)}
			{open ? (
				<>
					<Button size="sm" variant="outline" onClick={() => fit()}>
						画像全体
					</Button>
					<Button
						size="sm"
						variant="outline"
						disabled={!target}
						onClick={() => fit(target)}
					>
						選択領域を拡大
					</Button>
					<Button
						size="sm"
						variant="outline"
						aria-label="縮小"
						onClick={() => setScale((n) => Math.max(1, n / 1.5))}
					>
						−
					</Button>
					<output aria-label="拡大倍率">{Math.round(scale * 100)}%</output>
					<Button
						size="sm"
						variant="outline"
						aria-label="拡大"
						onClick={() => setScale((n) => Math.min(20, n * 1.5))}
					>
						＋
					</Button>
				</>
			) : (
				<Button
					ref={openButton}
					size="sm"
					variant="outline"
					onClick={() => {
						setScale(1);
						setOpen(true);
					}}
				>
					大きく表示
				</Button>
			)}
			{selecting && !props.selectionRegion && (
				<Button
					size="sm"
					variant="outline"
					onClick={() => props.onRegion?.([0, 0, props.width, props.height])}
				>
					画像全体に枠を作る
				</Button>
			)}
		</div>
	);
	const coordinates = selecting && props.selectionRegion && (
		<fieldset className="ocr-region-coordinates">
			<legend>選択範囲の調整</legend>
			{["左", "上", "幅", "高さ"].map((label, index) => (
				<label key={label}>
					{label}
					<input
						type="number"
						aria-label={`範囲の${label}`}
						min={index < 2 ? 0 : 1}
						max={index % 2 === 0 ? props.width : props.height}
						value={Math.round(props.selectionRegion![index]!)}
						onChange={(e) => {
							const n = Number(e.target.value);
							if (!Number.isFinite(n)) return;
							const r: OcrRegion = [...props.selectionRegion!];
							r[index] = n;
							if (
								r[0] >= 0 &&
								r[1] >= 0 &&
								r[2] >= 1 &&
								r[3] >= 1 &&
								r[0] + r[2] <= props.width &&
								r[1] + r[3] <= props.height
							)
								props.onRegion?.(r);
						}}
					/>
				</label>
			))}
		</fieldset>
	);
	const contents = (
		<>
			{controls}
			{selecting && (
				<p className="ocr-source-hint">
					行全体を囲んでください。枠をまたぐ行は含みません。枠の移動・四隅の調整ができます。
				</p>
			)}
			{coordinates}
			<div
				className={`ocr-stage-scroll${open ? " expanded" : ""}`}
				ref={scrollRef}
			>
				<Stage
					{...props}
					selecting={selecting}
					scale={scale}
					scrollRef={scrollRef}
					baseWidth={baseWidth}
					expanded={open}
				/>
			</div>
		</>
	);
	return (
		<>
			{!open && contents}
			<FullscreenDialog
				open={open}
				title="OCR原画像の拡大表示"
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					openButton.current?.focus();
				}}
				onOpenChange={(value) => {
					setOpen(value);
					setScale(1);
				}}
			>
				{open && contents}
			</FullscreenDialog>
		</>
	);
}
