import * as React from "react";
import { cn } from "@/utils/cn";
import {
	type AngleGeometry,
	angleGeometry,
	arePoints,
	boundsCenter,
	DIAGRAM_HEIGHT,
	DIAGRAM_WIDTH,
	type DiagramAspect,
	fmt,
	isFiniteNumber,
	lineLabelPosition,
	type Point,
	pointsAttribute,
	rotateTransform,
} from "./geometry";

/**
 * 座標0〜100の viewBox に、評価済みの数値で要素を描く図解部品。
 *
 * 座標系: 左上が原点、x は右向き、y は下向き。幅は 100 固定、高さは aspect で決まる
 * （landscape 100×56.25 / square 100×100 / wide 100×42.86）。
 * 角度（angle の from/to、rotate）は度数法で、x 軸正方向から反時計回りが正。
 * 式の評価は呼び出し側が行い、ここには有限の数値だけを渡す。非有限の数値を含む要素は描かない。
 */

export type { DiagramAspect } from "./geometry";

export type DiagramColor =
	| "accent"
	| "ink"
	| "muted"
	| "positive"
	| "negative"
	| "warning";

export type DiagramLabelSize = "sm" | "md" | "lg";
export type DiagramLabelAlign = "start" | "middle" | "end";

export interface DiagramElementBase {
	color?: DiagramColor;
	/** false のとき描かない（既定 true）。 */
	visible?: boolean;
	/** true のとき太線・発光で強調する。 */
	highlighted?: boolean;
}

export interface DiagramShapeElement extends DiagramElementBase {
	type: "shape";
	shape: "rect" | "ellipse";
	/** 外接する矩形の左上。 */
	x: number;
	y: number;
	w: number;
	h: number;
	/** 図形の中心まわりの回転（度、反時計回りが正）。 */
	rotate?: number;
	filled?: boolean;
	label?: string;
}

export interface DiagramPolygonElement extends DiagramElementBase {
	type: "polygon";
	points: ReadonlyArray<readonly [number, number]>;
	/** 度、反時計回りが正。 */
	rotate?: number;
	/** 回転の中心。省略すると外接矩形の中心。 */
	origin?: readonly [number, number];
	filled?: boolean;
}

export interface DiagramPolylineElement extends DiagramElementBase {
	type: "polyline";
	points: ReadonlyArray<readonly [number, number]>;
	dashed?: boolean;
}

export interface DiagramLineElement extends DiagramElementBase {
	type: "line" | "arrow";
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	dashed?: boolean;
	label?: string;
}

export interface DiagramLabelElement extends DiagramElementBase {
	type: "label";
	x: number;
	y: number;
	text: string;
	size?: DiagramLabelSize;
	align?: DiagramLabelAlign;
}

export interface DiagramAngleElement extends DiagramElementBase {
	type: "angle";
	/** 頂点。 */
	x: number;
	y: number;
	/** 開始角（度、x 軸正方向から反時計回り）。from から to へ反時計回りに弧を描く。 */
	from: number;
	to: number;
	radius: number;
	label?: string;
}

export type DiagramElement =
	| DiagramShapeElement
	| DiagramPolygonElement
	| DiagramPolylineElement
	| DiagramLineElement
	| DiagramLabelElement
	| DiagramAngleElement;

export interface DiagramProps {
	elements: ReadonlyArray<DiagramElement>;
	aspect?: DiagramAspect;
	title?: string;
	caption?: string;
	className?: string;
}

const COLOR_VALUE: Record<DiagramColor, string> = {
	accent: "var(--ds-accent, var(--primary))",
	ink: "var(--foreground)",
	muted: "var(--muted-foreground)",
	positive: "var(--success)",
	negative: "var(--destructive)",
	warning: "var(--warning)",
};

const LABEL_FONT_SIZE: Record<DiagramLabelSize, number> = {
	sm: 3,
	md: 3.8,
	lg: 5,
};

const STROKE = 0.5;
const STROKE_HIGHLIGHT = 1;
const FILL_OPACITY = 0.22;
const DASH = "2 1.4";

type Paint = {
	color: string;
	strokeWidth: number;
	highlighted: boolean;
	style?: React.CSSProperties;
};

const paintOf = (element: DiagramElementBase): Paint => {
	const color = COLOR_VALUE[element.color ?? "ink"] ?? COLOR_VALUE.ink;
	const highlighted = element.highlighted === true;
	return {
		color,
		highlighted,
		strokeWidth: highlighted ? STROKE_HIGHLIGHT : STROKE,
		style: highlighted
			? { filter: `drop-shadow(0 0 1.2px ${color})` }
			: undefined,
	};
};

const colorKey = (element: DiagramElementBase) =>
	COLOR_VALUE[element.color ?? "ink"] ? (element.color ?? "ink") : "ink";

type TextProps = {
	x: number;
	y: number;
	text: string;
	color: string;
	size: number;
	anchor: DiagramLabelAlign;
	bold?: boolean;
};

const DiagramText = ({ x, y, text, color, size, anchor, bold }: TextProps) => (
	<text
		x={fmt(x)}
		y={fmt(y)}
		fill={color}
		fontSize={size}
		fontWeight={bold ? 700 : 500}
		textAnchor={anchor}
		dominantBaseline="central"
		stroke="var(--card)"
		strokeWidth={0.9}
		strokeLinejoin="round"
		paintOrder="stroke"
	>
		{text}
	</text>
);

const nonEmpty = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0;

/** 要素が描画できる（必要な数値がすべて有限）かどうか。 */
const isDrawable = (element: DiagramElement): boolean => {
	const finite = (...values: Array<number | undefined>) =>
		values.every((v) => v === undefined || isFiniteNumber(v));
	switch (element.type) {
		case "shape":
			return (
				finite(element.x, element.y, element.w, element.h, element.rotate) &&
				element.w >= 0 &&
				element.h >= 0
			);
		case "polygon":
			return (
				arePoints(element.points, 3) &&
				finite(element.rotate) &&
				(element.origin === undefined || arePoints([element.origin], 1))
			);
		case "polyline":
			return arePoints(element.points, 2);
		case "line":
		case "arrow":
			return (
				finite(element.x1, element.y1, element.x2, element.y2) &&
				(element.x1 !== element.x2 || element.y1 !== element.y2)
			);
		case "label":
			return finite(element.x, element.y) && nonEmpty(element.text);
		case "angle":
			return finite(
				element.x,
				element.y,
				element.from,
				element.to,
				element.radius,
			);
		default:
			return false;
	}
};

const labelsOf = (element: DiagramElement): string[] => {
	if (element.type === "label") return [element.text];
	if (
		element.type === "shape" ||
		element.type === "line" ||
		element.type === "arrow" ||
		element.type === "angle"
	) {
		return nonEmpty(element.label) ? [element.label] : [];
	}
	return [];
};

const MAX_ARIA_LENGTH = 240;

const summarize = (title: string | undefined, labels: string[]): string => {
	const head = title && title.length > 0 ? title : "図解";
	const body = labels.join("、");
	const text = body ? `${head}: ${body}` : head;
	return text.length > MAX_ARIA_LENGTH
		? `${text.slice(0, MAX_ARIA_LENGTH - 1)}…`
		: text;
};

const markerId = (base: string, key: string, highlighted: boolean) =>
	`${base}-arrow-${key}${highlighted ? "-hl" : ""}`;

const renderShape = (el: DiagramShapeElement, paint: Paint) => {
	const cx = el.x + el.w / 2;
	const cy = el.y + el.h / 2;
	const common = {
		fill: el.filled ? paint.color : "none",
		fillOpacity: el.filled ? FILL_OPACITY : undefined,
		stroke: paint.color,
		strokeWidth: paint.strokeWidth,
		strokeLinejoin: "round" as const,
	};
	return (
		<>
			<g transform={rotateTransform(el.rotate ?? 0, cx, cy)}>
				{el.shape === "ellipse" ? (
					<ellipse
						cx={fmt(cx)}
						cy={fmt(cy)}
						rx={fmt(el.w / 2)}
						ry={fmt(el.h / 2)}
						{...common}
					/>
				) : (
					<rect
						x={fmt(el.x)}
						y={fmt(el.y)}
						width={fmt(el.w)}
						height={fmt(el.h)}
						rx={0.8}
						{...common}
					/>
				)}
			</g>
			{nonEmpty(el.label) ? (
				<DiagramText
					x={cx}
					y={cy}
					text={el.label}
					color={paint.color}
					size={LABEL_FONT_SIZE.md}
					anchor="middle"
					bold={paint.highlighted}
				/>
			) : null}
		</>
	);
};

const renderPolygon = (el: DiagramPolygonElement, paint: Paint) => {
	const [cx, cy] = el.origin ?? boundsCenter(el.points);
	return (
		<polygon
			points={pointsAttribute(el.points)}
			transform={rotateTransform(el.rotate ?? 0, cx, cy)}
			fill={el.filled ? paint.color : "none"}
			fillOpacity={el.filled ? FILL_OPACITY : undefined}
			stroke={paint.color}
			strokeWidth={paint.strokeWidth}
			strokeLinejoin="round"
		/>
	);
};

const renderPolyline = (el: DiagramPolylineElement, paint: Paint) => (
	<polyline
		points={pointsAttribute(el.points)}
		fill="none"
		stroke={paint.color}
		strokeWidth={paint.strokeWidth}
		strokeLinejoin="round"
		strokeLinecap="round"
		strokeDasharray={el.dashed ? DASH : undefined}
	/>
);

const renderLine = (
	el: DiagramLineElement,
	paint: Paint,
	arrowId: string | undefined,
) => {
	const position = nonEmpty(el.label)
		? lineLabelPosition(el.x1, el.y1, el.x2, el.y2)
		: null;
	return (
		<>
			<line
				x1={fmt(el.x1)}
				y1={fmt(el.y1)}
				x2={fmt(el.x2)}
				y2={fmt(el.y2)}
				stroke={paint.color}
				strokeWidth={paint.strokeWidth}
				strokeLinecap="round"
				strokeDasharray={el.dashed ? DASH : undefined}
				markerEnd={arrowId ? `url(#${arrowId})` : undefined}
			/>
			{position && nonEmpty(el.label) ? (
				<DiagramText
					x={position.x}
					y={position.y}
					text={el.label}
					color={paint.color}
					size={LABEL_FONT_SIZE.md}
					anchor={position.anchor}
					bold={paint.highlighted}
				/>
			) : null}
		</>
	);
};

const renderLabel = (el: DiagramLabelElement, paint: Paint) => (
	<DiagramText
		x={el.x}
		y={el.y}
		text={el.text}
		color={paint.color}
		size={LABEL_FONT_SIZE[el.size ?? "md"] ?? LABEL_FONT_SIZE.md}
		anchor={el.align ?? "middle"}
		bold={paint.highlighted}
	/>
);

const renderAngle = (
	el: DiagramAngleElement,
	paint: Paint,
	geometry: AngleGeometry,
) => (
	<>
		<path
			d={geometry.path}
			data-angle-kind={geometry.kind}
			fill="none"
			stroke={paint.color}
			strokeWidth={paint.strokeWidth}
			strokeLinecap="round"
			strokeLinejoin="round"
		/>
		{nonEmpty(el.label) ? (
			<DiagramText
				x={geometry.label[0]}
				y={geometry.label[1]}
				text={el.label}
				color={paint.color}
				size={LABEL_FONT_SIZE.md}
				anchor="middle"
				bold={paint.highlighted}
			/>
		) : null}
	</>
);

const ArrowMarker = ({
	id,
	color,
	size,
}: {
	id: string;
	color: string;
	size: number;
}) => (
	<marker
		id={id}
		viewBox="0 0 10 10"
		refX={8.5}
		refY={5}
		markerUnits="userSpaceOnUse"
		markerWidth={size}
		markerHeight={size}
		orient="auto"
	>
		<path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
	</marker>
);

const Diagram = React.forwardRef<HTMLElement, DiagramProps>(
	({ elements, aspect = "landscape", title, caption, className }, ref) => {
		const baseId = React.useId().replace(/[^a-zA-Z0-9_-]/g, "");
		const height = DIAGRAM_HEIGHT[aspect] ?? DIAGRAM_HEIGHT.landscape;

		const drawable = elements.filter(
			(el) => el.visible !== false && isDrawable(el),
		);

		const arrowKeys = new Map<string, { color: string; highlighted: boolean }>();
		for (const el of drawable) {
			if (el.type !== "arrow") continue;
			const highlighted = el.highlighted === true;
			arrowKeys.set(markerId(baseId, colorKey(el), highlighted), {
				color: paintOf(el).color,
				highlighted,
			});
		}

		const labels = drawable.flatMap(labelsOf);

		return (
			<figure
				ref={ref}
				className={cn(
					"m-0 flex w-full flex-col gap-2 rounded-lg border border-border bg-card p-3 text-card-foreground",
					className,
				)}
			>
				{title ? (
					<div className="text-sm font-semibold text-foreground">{title}</div>
				) : null}
				<svg
					role="img"
					aria-label={summarize(title, labels)}
					viewBox={`0 0 ${DIAGRAM_WIDTH} ${fmt(height)}`}
					className="block h-auto w-full"
					fontFamily="inherit"
				>
					{arrowKeys.size > 0 ? (
						<defs>
							{[...arrowKeys].map(([id, { color, highlighted }]) => (
								<ArrowMarker
									key={id}
									id={id}
									color={color}
									size={highlighted ? 4.4 : 3.4}
								/>
							))}
						</defs>
					) : null}
					{drawable.map((el, index) => {
						const paint = paintOf(el);
						let content: React.ReactNode = null;
						switch (el.type) {
							case "shape":
								content = renderShape(el, paint);
								break;
							case "polygon":
								content = renderPolygon(el, paint);
								break;
							case "polyline":
								content = renderPolyline(el, paint);
								break;
							case "line":
								content = renderLine(el, paint, undefined);
								break;
							case "arrow":
								content = renderLine(
									el,
									paint,
									markerId(baseId, colorKey(el), paint.highlighted),
								);
								break;
							case "label":
								content = renderLabel(el, paint);
								break;
							case "angle": {
								const geometry = angleGeometry(
									el.x,
									el.y,
									el.from,
									el.to,
									el.radius,
								);
								content = geometry ? renderAngle(el, paint, geometry) : null;
								break;
							}
						}
						if (content === null) return null;
						return (
							<g
								// biome-ignore lint/suspicious/noArrayIndexKey: 図解の要素は順序が識別子で、並べ替えない。
								key={index}
								data-diagram-element={el.type}
								data-highlighted={paint.highlighted ? "true" : undefined}
								style={paint.style}
							>
								{content}
							</g>
						);
					})}
				</svg>
				{caption ? (
					<figcaption className="text-xs text-muted-foreground">
						{caption}
					</figcaption>
				) : null}
			</figure>
		);
	},
);
Diagram.displayName = "Diagram";

export { Diagram };
export type { Point as DiagramPoint };
