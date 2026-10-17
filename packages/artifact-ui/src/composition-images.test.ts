import { describe, expect, test } from "bun:test";
import type { ImageSpec } from "./composition-contracts";
import { aspectSize, resolveCompositionImage } from "./composition-images";
import { picsumThemeNames, picsumThemes } from "./picsum-themes";

type PicsumSpec = Extract<ImageSpec, { provider: "picsum" }>;
const picsum = (over: Partial<PicsumSpec> = {}): PicsumSpec => ({
	provider: "picsum",
	theme: "nature",
	alt: "a landscape",
	...over,
});
const size = { width: 640, height: 360 };
const resolveSrc = (spec: ImageSpec, s = size) => {
	const image = resolveCompositionImage(spec, s);
	if (!("src" in image)) throw new Error("expected a picture");
	return image;
};
const idOf = (src: string) => Number(/\/id\/(\d+)\//.exec(src)?.[1]);

describe("resolveCompositionImage", () => {
	test("the same spec always gives the same url", () => {
		const a = resolveSrc(picsum({ seed: "abc" }));
		const b = resolveSrc(picsum({ seed: "abc" }));
		expect(a).toEqual(b);
		expect(a.src).toMatch(/^https:\/\/picsum\.photos\/id\/\d+\/640\/360$/);
		expect(a.alt).toBe("a landscape");
	});

	test("the id comes from the catalog of the theme", () => {
		for (const theme of picsumThemeNames) {
			const { src } = resolveSrc(picsum({ theme, seed: "x1" }));
			expect(picsumThemes[theme] as readonly number[]).toContain(idOf(src));
		}
	});

	test("an omitted seed is the seed 1, and other seeds reach other pictures", () => {
		expect(resolveSrc(picsum()).src).toBe(
			resolveSrc(picsum({ seed: "1" })).src,
		);
		const ids = new Set(
			Array.from({ length: 40 }, (_, i) =>
				idOf(resolveSrc(picsum({ seed: `s${i}` })).src),
			),
		);
		expect(ids.size).toBeGreaterThan(3);
	});

	test("filters go into the query; a blur of 0 adds nothing", () => {
		expect(resolveSrc(picsum({ grayscale: true })).src).toEndWith("?grayscale");
		expect(resolveSrc(picsum({ blur: 4 })).src).toEndWith("?blur=4");
		expect(resolveSrc(picsum({ grayscale: true, blur: 10 })).src).toEndWith(
			"?grayscale&blur=10",
		);
		expect(resolveSrc(picsum({ blur: 0 })).src).not.toContain("?");
		expect(resolveSrc(picsum({ grayscale: false })).src).not.toContain("?");
	});

	test("srcSet holds the 1x and 2x pictures, filters included", () => {
		const { src, srcSet } = resolveSrc(picsum({ blur: 2 }));
		const id = idOf(src);
		expect(srcSet).toBe(
			`https://picsum.photos/id/${id}/640/360?blur=2 1x, https://picsum.photos/id/${id}/1280/720?blur=2 2x`,
		);
	});

	test("sizes are rounded to integers and limited to 1..2400", () => {
		const rounded = resolveSrc(picsum(), { width: 100.6, height: 50.2 });
		expect(rounded.src).toEndWith("/101/50");
		expect(rounded.srcSet).toContain("/202/100 2x");
		const big = resolveSrc(picsum(), { width: 5000, height: 3000 });
		expect(big.src).toEndWith("/2400/1440");
		expect(big.srcSet).toContain("/2400/1440 2x");
		const small = resolveSrc(picsum(), { width: 0, height: -5 });
		expect(small.src).toEndWith("/1/1");
		const bad = resolveSrc(picsum(), { width: Number.NaN, height: 10 });
		expect(bad.src).toEndWith("/1/10");
	});

	test("the 2x size keeps the ratio when a side reaches the limit", () => {
		const landscape = resolveSrc(picsum(), { width: 1600, height: 900 });
		expect(landscape.src).toEndWith("/1600/900");
		expect(landscape.srcSet).toContain("/2400/1350 2x");
		const portrait = resolveSrc(picsum(), { width: 900, height: 1200 });
		expect(portrait.srcSet).toContain("/1800/2400 2x");
		const tall = resolveSrc(picsum(), { width: 1500, height: 3000 });
		expect(tall.src).toEndWith("/1200/2400");
		expect(tall.srcSet).toContain("/1200/2400 2x");
	});

	test("a placeholder spec resolves to its tone, neutral by default", () => {
		expect(
			resolveCompositionImage(
				{ provider: "placeholder", tone: "warm", alt: "x" },
				size,
			),
		).toEqual({ placeholder: "warm", alt: "x" });
		expect(resolveCompositionImage({ provider: "placeholder" }, size)).toEqual({
			placeholder: "neutral",
			alt: "",
		});
	});
});

describe("aspectSize", () => {
	test("gives the ratio of each aspect, landscape by default", () => {
		expect(aspectSize("landscape", 1600)).toEqual({ width: 1600, height: 900 });
		expect(aspectSize(undefined, 1600)).toEqual({ width: 1600, height: 900 });
		expect(aspectSize("square", 400)).toEqual({ width: 400, height: 400 });
		expect(aspectSize("portrait", 300)).toEqual({ width: 300, height: 400 });
		expect(aspectSize("wide", 2100)).toEqual({ width: 2100, height: 900 });
	});

	test("rounds to integers within 1..2400", () => {
		expect(aspectSize("landscape", 100)).toEqual({ width: 100, height: 56 });
		expect(aspectSize("portrait", 5000)).toEqual({ width: 1800, height: 2400 });
		expect(aspectSize("square", 0)).toEqual({ width: 1, height: 1 });
	});
});

describe("picsum catalog", () => {
	for (const theme of picsumThemeNames) {
		test(`${theme} has at least 6 distinct positive integer ids`, () => {
			const ids: readonly number[] = picsumThemes[theme];
			expect(ids.length).toBeGreaterThanOrEqual(6);
			expect(new Set(ids).size).toBe(ids.length);
			for (const id of ids) {
				expect(Number.isInteger(id) && id > 0).toBe(true);
			}
		});
	}
});
