import type { OcrLine } from "./types";
export type OcrRegion = [number, number, number, number];
export function ocrLinesInRegion(lines: OcrLine[], region: OcrRegion) {
	const [x, y, w, h] = region;
	return lines.flatMap((line, index) =>
		line.polygon.every(
			([px, py]) => px >= x && py >= y && px <= x + w && py <= y + h,
		)
			? [index]
			: [],
	);
}
export function ocrRegionBounds(
	points: [number, number][],
): OcrRegion | undefined {
	if (!points.length) return undefined;
	const xs = points.map((p) => p[0]),
		ys = points.map((p) => p[1]);
	const x = Math.min(...xs),
		y = Math.min(...ys);
	return [
		x,
		y,
		Math.max(1, Math.max(...xs) - x),
		Math.max(1, Math.max(...ys) - y),
	];
}
