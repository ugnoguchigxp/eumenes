/**
 * Diagram の座標系と幾何計算。
 *
 * - 座標は左上を原点とし、x は右向き、y は下向きに増える（SVG と同じ）。
 * - viewBox の幅は常に 100。高さは aspect で決まる（landscape 56.25 / square 100 / wide 42.86）。
 * - 角度（angle の from/to、図形の rotate）は度数法で、x 軸正方向から反時計回りを正とする
 *   （数学の向き）。SVG は y が下向きなので、描画時に y の符号を反転して変換する。
 */

export type DiagramAspect = "landscape" | "square" | "wide";

export const DIAGRAM_WIDTH = 100;

export const DIAGRAM_HEIGHT: Record<DiagramAspect, number> = {
	landscape: 56.25,
	square: 100,
	wide: 42.86,
};

export type Point = readonly [number, number];

export const isFiniteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

export const isPoint = (value: unknown): value is Point =>
	Array.isArray(value) &&
	value.length === 2 &&
	isFiniteNumber(value[0]) &&
	isFiniteNumber(value[1]);

export const arePoints = (value: unknown, min: number): value is Point[] =>
	Array.isArray(value) && value.length >= min && value.every(isPoint);

/** SVG 属性用に数値を丸める（-0 を 0 にし、小数 3 桁まで）。 */
export const fmt = (value: number): string => {
	const rounded = Math.round(value * 1000) / 1000;
	return String(Object.is(rounded, -0) ? 0 : rounded);
};

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** 頂点 (cx, cy) から、反時計回りの角度 degrees の向きへ distance 進んだ SVG 座標。 */
export const polar = (
	cx: number,
	cy: number,
	distance: number,
	degrees: number,
): Point => [
	cx + distance * Math.cos(toRadians(degrees)),
	cy - distance * Math.sin(toRadians(degrees)),
];

/** 反時計回りの回転角を、SVG の rotate() 変換（時計回りが正）の文字列へ変換する。 */
export const rotateTransform = (
	degrees: number,
	cx: number,
	cy: number,
): string | undefined =>
	degrees === 0 ? undefined : `rotate(${fmt(-degrees)} ${fmt(cx)} ${fmt(cy)})`;

export const boundsCenter = (points: readonly Point[]): Point => {
	const xs = points.map((p) => p[0]);
	const ys = points.map((p) => p[1]);
	return [
		(Math.min(...xs) + Math.max(...xs)) / 2,
		(Math.min(...ys) + Math.max(...ys)) / 2,
	];
};

export const pointsAttribute = (points: readonly Point[]): string =>
	points.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(" ");

/** from から to へ反時計回りに進む角度（0 以上 360 未満）。 */
export const counterClockwiseSweep = (from: number, to: number): number =>
	((((to - from) % 360) + 360) % 360);

export type AngleGeometry =
	| {
			kind: "arc";
			path: string;
			label: Point;
	  }
	| {
			kind: "right";
			path: string;
			label: Point;
	  };

const RIGHT_ANGLE_TOLERANCE = 0.5;

/** angle 要素の弧（90 度のときは直角記号）と、ラベルの位置を求める。描けないときは null。 */
export const angleGeometry = (
	cx: number,
	cy: number,
	from: number,
	to: number,
	radius: number,
): AngleGeometry | null => {
	if (radius <= 0) return null;
	const delta = counterClockwiseSweep(from, to);
	if (delta === 0) return null;
	const middle = from + delta / 2;
	const label = polar(cx, cy, radius + 3.2, middle);

	if (Math.abs(delta - 90) < RIGHT_ANGLE_TOLERANCE) {
		const side = radius * 0.6;
		const [ax, ay] = polar(cx, cy, side, from);
		const [bx, by] = polar(cx, cy, side, to);
		const corner: Point = [ax + bx - cx, ay + by - cy];
		return {
			kind: "right",
			path: `M ${fmt(ax)} ${fmt(ay)} L ${fmt(corner[0])} ${fmt(corner[1])} L ${fmt(bx)} ${fmt(by)}`,
			label,
		};
	}

	const [sx, sy] = polar(cx, cy, radius, from);
	const [ex, ey] = polar(cx, cy, radius, from + delta);
	const large = delta > 180 ? 1 : 0;
	// 反時計回りの弧は SVG では sweep-flag = 0。
	return {
		kind: "arc",
		path: `M ${fmt(sx)} ${fmt(sy)} A ${fmt(radius)} ${fmt(radius)} 0 ${large} 0 ${fmt(ex)} ${fmt(ey)}`,
		label,
	};
};

/** 線分の中点から、図の上側（縦線は右側）へずらしたラベル位置と文字の揃え。 */
export const lineLabelPosition = (
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	offset = 2.4,
): { x: number; y: number; anchor: "start" | "middle" | "end" } => {
	const dx = x2 - x1;
	const dy = y2 - y1;
	const length = Math.hypot(dx, dy) || 1;
	let nx = dy / length;
	let ny = -dx / length;
	if (ny > 0 || (Math.abs(ny) < 1e-9 && nx < 0)) {
		nx = -nx;
		ny = -ny;
	}
	const anchor = nx > 0.7 ? "start" : nx < -0.7 ? "end" : "middle";
	return {
		x: (x1 + x2) / 2 + nx * offset,
		y: (y1 + y2) / 2 + ny * offset,
		anchor,
	};
};
