import { afterAll, expect, test } from "bun:test";
// @ts-expect-error jsdom has no type declarations in this repository
import { JSDOM } from "jsdom";
import { compositionViewRegistry, featureIcons } from "./composition-contracts";
import { picsumThemes } from "./picsum-themes";
import type { ArtifactRequest } from "./contracts";

// The views need a DOM; bun test has none, so install jsdom's before React DOM loads.
const dom = new JSDOM("<!doctype html><html><body></body></html>");
const domGlobals = {
	window: dom.window,
	document: dom.window.document,
	IS_REACT_ACT_ENVIRONMENT: true,
};
Object.assign(globalThis, domGlobals);
afterAll(() => {
	for (const name of Object.keys(domGlobals))
		Reflect.deleteProperty(globalThis, name);
});
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { featureCardIconNames } = await import("@eumenes/design-system");
const views = await import("./composition-marketing-components");

type RegistryKey = keyof typeof compositionViewRegistry;
/** Parses with the view's own schema, so the test only uses requests a user could save. */
function parse(key: RegistryKey, value: unknown): ArtifactRequest {
	return compositionViewRegistry[key].schema.parse(value) as ArtifactRequest;
}

async function render(
	View: (props: { request: ArtifactRequest }) => unknown,
	request: ArtifactRequest,
) {
	const container = document.createElement("div");
	const root = createRoot(container);
	await act(async () => {
		root.render(
			(View as (p: { request: ArtifactRequest }) => React.ReactElement)({
				request,
			}) ?? null,
		);
	});
	return {
		container,
		unmount: () => act(async () => root.unmount()),
	};
}

const picsumAlt = (alt: string) => ({
	provider: "picsum" as const,
	theme: "coffee" as const,
	seed: "demo",
	alt,
});
const catalogIds = (theme: keyof typeof picsumThemes) =>
	picsumThemes[theme] as readonly number[];

function expectCatalogPhoto(img: Element | null, alt: string) {
	expect(img).not.toBeNull();
	expect(img?.getAttribute("alt")).toBe(alt);
	expect(img?.getAttribute("referrerpolicy")).toBe("no-referrer");
	expect(img?.getAttribute("loading")).toBe("lazy");
	const src = img?.getAttribute("src") ?? "";
	const match = /^https:\/\/picsum\.photos\/id\/(\d+)\/\d+\/\d+/.exec(src);
	expect(match).not.toBeNull();
	expect(catalogIds("coffee")).toContain(Number(match?.[1]));
	expect(img?.getAttribute("srcset")).toContain("2x");
}

test("hero draws the text, display-only labels and a catalog photo", async () => {
	const request = parse("hero", {
		view: "hero",
		variant: "split",
		eyebrow: "新登場",
		title: "朝の一杯を、ていねいに",
		body: "産地ごとに焙煎します。",
		primaryLabel: "商品を見る",
		secondaryLabel: "ガイド",
		image: picsumAlt("珈琲豆"),
	});
	const { container, unmount } = await render(views.HeroView, request);
	expect(container.querySelector("h2")?.textContent).toBe(
		"朝の一杯を、ていねいに",
	);
	expect(container.textContent).toContain("商品を見る");
	expect(container.querySelector("button, a")).toBeNull();
	expect(container.querySelector("section")?.getAttribute("data-variant")).toBe(
		"split",
	);
	expectCatalogPhoto(container.querySelector("img"), "珈琲豆");
	await unmount();
});

test("hero background asks for a wider picture and keeps overlay options", async () => {
	const request = parse("hero", {
		view: "hero",
		variant: "background",
		title: "背景",
		overlay: "light",
		align: "start",
		height: "lg",
		image: picsumAlt("海辺"),
	});
	const { container, unmount } = await render(views.HeroView, request);
	const section = container.querySelector("section");
	expect(section?.getAttribute("data-overlay")).toBe("light");
	expect(section?.getAttribute("data-align")).toBe("start");
	expect(section?.getAttribute("data-height")).toBe("lg");
	expect(container.querySelector("img")?.getAttribute("src")).toContain(
		"/1600/900",
	);
	await unmount();
});

test("hero without an image draws only the text", async () => {
	const request = parse("hero", { view: "hero", title: "見出し" });
	const { container, unmount } = await render(views.HeroView, request);
	expect(container.querySelector("img")).toBeNull();
	expect(container.querySelector("h2")?.textContent).toBe("見出し");
	await unmount();
});

test("image view uses the aspect for the frame and the picture size", async () => {
	const request = parse("image", {
		view: "image",
		image: picsumAlt("机"),
		aspect: "square",
		caption: "作業机",
	});
	const { container, unmount } = await render(views.ContentImageView, request);
	expectCatalogPhoto(container.querySelector("img"), "机");
	expect(container.querySelector("img")?.getAttribute("src")).toContain(
		"/1200/1200",
	);
	expect(
		container.querySelector("[data-aspect]")?.getAttribute("data-aspect"),
	).toBe("square");
	expect(container.querySelector("figcaption")?.textContent).toBe("作業机");
	await unmount();
});

test("image view draws a placeholder without any network picture", async () => {
	const request = parse("image", {
		view: "image",
		image: { provider: "placeholder", tone: "warm" },
	});
	const { container, unmount } = await render(views.ContentImageView, request);
	expect(container.querySelector("img")).toBeNull();
	expect(container.querySelector("[data-placeholder='warm']")).not.toBeNull();
	expect(container.querySelector("[aria-hidden='true']")).not.toBeNull();
	await unmount();
});

test("media card draws its text and a catalog photo", async () => {
	const request = parse("media-card", {
		view: "media-card",
		variant: "horizontal",
		image: picsumAlt("畑"),
		aspect: "portrait",
		eyebrow: "特集",
		title: "畑から食卓へ",
		body: "旬の野菜です。",
	});
	const { container, unmount } = await render(views.MediaCardView, request);
	expect(container.querySelector("article")?.getAttribute("data-variant")).toBe(
		"horizontal",
	);
	expect(container.querySelector("h3")?.textContent).toBe("畑から食卓へ");
	expectCatalogPhoto(container.querySelector("img"), "畑");
	expect(container.querySelector("img")?.getAttribute("src")).toContain(
		"/800/1067",
	);
	await unmount();
});

test("product card shows price, badge and rating with an optional photo", async () => {
	const request = parse("product-card", {
		view: "product-card",
		image: picsumAlt("豆の袋"),
		name: "ハンドドリップ珈琲",
		price: "¥1,800",
		compareAtPrice: "¥2,400",
		badge: "sale",
		rating: 4.5,
	});
	const { container, unmount } = await render(views.ProductCardView, request);
	expect(container.querySelector("h3")?.textContent).toBe("ハンドドリップ珈琲");
	expect(container.textContent).toContain("¥1,800");
	expect(container.querySelector("s")?.textContent).toContain("¥2,400");
	expect(container.textContent).toContain("セール");
	expect(container.textContent).toContain("5点満点中4.5点");
	expectCatalogPhoto(container.querySelector("img"), "豆の袋");
	await unmount();
});

test("product card without an image still draws", async () => {
	const request = parse("product-card", {
		view: "product-card",
		name: "商品",
		price: "¥100",
	});
	const { container, unmount } = await render(views.ProductCardView, request);
	expect(container.querySelector("img")).toBeNull();
	expect(container.querySelector("h3")?.textContent).toBe("商品");
	await unmount();
});

test("feature card draws its icon, title and body", async () => {
	const request = parse("feature-card", {
		view: "feature-card",
		icon: "truck",
		title: "全国送料無料",
		body: "3,000円以上で無料です。",
	});
	const { container, unmount } = await render(views.FeatureCardView, request);
	expect(container.querySelector("h3")?.textContent).toBe("全国送料無料");
	expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
		"true",
	);
	expect(container.textContent).toContain("3,000円以上で無料です。");
	await unmount();
});

test("the design system's icon names are exactly the contract's featureIcons", () => {
	expect([...featureCardIconNames].sort()).toEqual([...featureIcons].sort());
});

test("testimonial draws the quote, person and catalog avatar", async () => {
	const request = parse("testimonial", {
		view: "testimonial",
		quote: "毎朝の楽しみになりました。",
		name: "佐藤 花子",
		role: "会社員",
		avatar: { ...picsumAlt("佐藤さん"), theme: "people" },
	});
	const { container, unmount } = await render(views.TestimonialView, request);
	expect(container.querySelector("blockquote")?.textContent).toBe(
		"毎朝の楽しみになりました。",
	);
	expect(container.textContent).toContain("会社員");
	const img = container.querySelector("img");
	expect(img?.getAttribute("referrerpolicy")).toBe("no-referrer");
	expect(img?.getAttribute("src")).toMatch(
		/^https:\/\/picsum\.photos\/id\/\d+\/160\/160/,
	);
	expect(catalogIds("people")).toContain(
		Number(/\/id\/(\d+)\//.exec(img?.getAttribute("src") ?? "")?.[1]),
	);
	await unmount();
});

test("testimonial without an avatar shows the initial", async () => {
	const request = parse("testimonial", {
		view: "testimonial",
		quote: "良い",
		name: "佐藤 花子",
	});
	const { container, unmount } = await render(views.TestimonialView, request);
	expect(container.querySelector("img")).toBeNull();
	expect(container.querySelector(".ds-testimonial-initial")?.textContent).toBe(
		"佐",
	);
	await unmount();
});

test("cta banner draws labels, and the image variant a catalog backdrop", async () => {
	const request = parse("cta-banner", {
		view: "cta-banner",
		variant: "image",
		title: "今すぐはじめましょう",
		primaryLabel: "無料で試す",
		image: picsumAlt("珈琲"),
	});
	const { container, unmount } = await render(views.CtaBannerView, request);
	expect(container.querySelector("h2")?.textContent).toBe(
		"今すぐはじめましょう",
	);
	expect(container.textContent).toContain("無料で試す");
	expect(container.querySelector("button, a")).toBeNull();
	expectCatalogPhoto(container.querySelector("img"), "珈琲");
	await unmount();
});

test("cta banner accent has no picture; a placeholder image becomes a gradient frame", async () => {
	const accent = await render(
		views.CtaBannerView,
		parse("cta-banner", { view: "cta-banner", title: "t" }),
	);
	expect(accent.container.querySelector("img")).toBeNull();
	await accent.unmount();
	const ph = await render(
		views.CtaBannerView,
		parse("cta-banner", {
			view: "cta-banner",
			variant: "image",
			title: "t",
			image: { provider: "placeholder", tone: "cool" },
		}),
	);
	expect(ph.container.querySelector("img")).toBeNull();
	expect(
		ph.container.querySelector("[data-placeholder='cool']"),
	).not.toBeNull();
	await ph.unmount();
});

test("each view renders nothing for another view's request", async () => {
	const other = parse("feature-card", { view: "feature-card", title: "t" });
	for (const View of [
		views.HeroView,
		views.ContentImageView,
		views.MediaCardView,
		views.ProductCardView,
		views.TestimonialView,
		views.CtaBannerView,
	]) {
		const { container, unmount } = await render(View, other);
		expect(container.innerHTML).toBe("");
		await unmount();
	}
});
