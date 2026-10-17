/**
 * Resolves the UI studio's image specs to something a view can show. A picsum image is chosen
 * from the checked catalog of its theme by a stable hash, so a saved work always shows the same
 * picture; the URL is built in one place and holds only a catalog id, integer sizes and filters.
 */
import type { ImageSpec } from "./composition-contracts";
import { picsumThemes } from "./picsum-themes";

export type ImageAspect = "landscape" | "square" | "portrait" | "wide";
export type ResolvedCompositionImage =
	| { src: string; srcSet: string; alt: string }
	| { placeholder: "accent" | "neutral" | "warm" | "cool"; alt: string };

const maxDimension = 2400;
const defaultSeed = "1";
const aspectRatios: Record<ImageAspect, number> = {
	landscape: 16 / 9,
	square: 1,
	portrait: 3 / 4,
	wide: 21 / 9,
};

/** FNV-1a (32 bit) of a string. */
function hash(value: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		h ^= value.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

const finite = (value: number) => (Number.isFinite(value) ? value : 1);

/** Rounds a size to integers of 1..2400, shrinking both sides together to keep the ratio. */
function fitSize(
	width: number,
	height: number,
): { width: number; height: number } {
	const w = Math.max(1, finite(width));
	const h = Math.max(1, finite(height));
	const scale = Math.min(1, maxDimension / Math.max(w, h));
	const round = (value: number) =>
		Math.min(maxDimension, Math.max(1, Math.round(value * scale)));
	return { width: round(w), height: round(h) };
}

/** The size of an image of the aspect at the width (landscape when the aspect is omitted). */
export function aspectSize(
	aspect: ImageAspect | undefined,
	width: number,
): { width: number; height: number } {
	const w = Math.max(1, finite(width));
	return fitSize(w, w / aspectRatios[aspect ?? "landscape"]);
}

function buildPicsumUrl(
	id: number,
	width: number,
	height: number,
	grayscale: boolean,
	blur: number,
): string {
	const query: string[] = [];
	if (grayscale) query.push("grayscale");
	const level = Math.min(10, Math.max(0, Math.round(blur) || 0));
	if (level > 0) query.push(`blur=${level}`);
	const suffix = query.length > 0 ? `?${query.join("&")}` : "";
	return `https://picsum.photos/id/${Math.trunc(id)}/${Math.trunc(width)}/${Math.trunc(height)}${suffix}`;
}

export function resolveCompositionImage(
	spec: ImageSpec,
	size: { width: number; height: number },
): ResolvedCompositionImage {
	if (spec.provider === "placeholder") {
		return { placeholder: spec.tone ?? "neutral", alt: spec.alt ?? "" };
	}
	const catalog: readonly number[] = picsumThemes[spec.theme];
	if (catalog.length === 0) return { placeholder: "neutral", alt: spec.alt };
	const id =
		catalog[hash(`${spec.theme}:${spec.seed ?? defaultSeed}`) % catalog.length];
	if (id === undefined) return { placeholder: "neutral", alt: spec.alt };
	const grayscale = spec.grayscale === true;
	const blur = spec.blur ?? 0;
	const base = fitSize(size.width, size.height);
	const at = (scale: number) => {
		const fit = fitSize(base.width * scale, base.height * scale);
		return buildPicsumUrl(id, fit.width, fit.height, grayscale, blur);
	};
	return { src: at(1), srcSet: `${at(1)} 1x, ${at(2)} 2x`, alt: spec.alt };
}
