import { expect, test, type Locator, type Page } from "@playwright/test";
import { createFixture } from "./fixture";

/**
 * The UI studio's expressive parts in a real browser (spec ui-studio-expressive-parts-implementation-plan
 * §11): pictures from picsum under the CSP, a chart that has a size, inputs that recompute stats, the
 * calculator handing its result to a formula, slides that keep their input, and readable text in the
 * dark theme.
 *
 * Fixture contract (scripts/ui-compositions-fixture-server.ts): the normal addressee delegates each
 * request below to `ui_create`, and the specialist applies the matching finished definition (the
 * ui-compositions acceptance fixtures U1, U4 and U5b, and a small slides composition).
 */
const requests = {
	landing: "ランディングページを作ってください",
	retirement: "老後資金のシミュレーターを作ってください",
	triangulation: "三角測量の説明ページを作ってください",
	slides: "紙芝居を作ってください",
};

declare global {
	interface Window {
		__cspViolations: string[];
	}
}

test.setTimeout(90000);
const fixture = createFixture();
let origin: string;
test.beforeAll(async () => {
	const [apiPort, webPort] = (await fixture.ports(2)) as [number, number];
	origin = `http://127.0.0.1:${webPort}`;
	await fixture.launch(
		["scripts/ui-compositions-fixture-server.ts"],
		{ EUMENES_PORT: String(apiPort), EUMENES_ORIGIN: origin },
		{ ports: [apiPort] },
	);
	await fixture.ready(`http://127.0.0.1:${apiPort}/api/status`);
	await fixture.launchWeb({
		webPort,
		apiPort,
		token: "fixture-token-for-toolchain-browser",
		cacheDir: `/tmp/eumenes-ui-parts-vite-${webPort}`,
	});
	await fixture.ready(origin);
});
test.afterAll(() => fixture.stopAll());

/** Opens the app, sends one request and returns the studio's preview once the draft is shown. */
async function compose(page: Page, request: string, heading: string) {
	await page.addInitScript(() => {
		window.__cspViolations = [];
		document.addEventListener("securitypolicyviolation", (e) =>
			window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`),
		);
	});
	await page.goto(origin);
	const conversation = page.getByRole("region", { name: "会話" });
	await conversation.getByRole("textbox", { name: "メッセージ" }).fill(request);
	await conversation.getByRole("button", { name: "送信", exact: true }).click();
	const studio = page.locator(".aui-ui-studio");
	// Each run starts Vite with an empty cache; the first studio load transforms recharts and KaTeX.
	await expect(studio).toBeVisible({ timeout: 60000 });
	const preview = studio.locator(".aui-ui-preview-canvas");
	await expect(preview.getByText(heading).first()).toBeVisible();
	return preview;
}
/** CSP violations so far; zod's one `new Function("")` probe is expected (see csp.spec.ts). */
const violations = (page: Page) =>
	page
		.evaluate(() => window.__cspViolations)
		.then((list) => list.filter((v) => v !== "script-src eval"));
const statValue = (preview: Locator, label: string) =>
	preview
		.locator(".ds-stat-tile")
		.filter({ hasText: label })
		.locator(".ds-stat-tile-value");

test("pictures of the landing page load from picsum without a CSP violation", async ({
	page,
}) => {
	const preview = await compose(
		page,
		requests.landing,
		"夜明けの一杯を、ていねいに",
	);
	const pictures = preview.locator('img[src^="https://picsum.photos/id/"]');
	await expect(pictures.first()).toBeVisible();
	const count = await pictures.count();
	expect(count).toBeGreaterThan(0);
	for (let index = 0; index < count; index++) {
		const picture = pictures.nth(index);
		await picture.scrollIntoViewIfNeeded();
		await expect
			.poll(() =>
				picture.evaluate(
					(image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
				),
			)
			.toBe(true);
		await expect(picture).toHaveAttribute("referrerpolicy", "no-referrer");
	}
	expect(await violations(page)).toEqual([]);
});

test("the retirement simulator draws its chart and recomputes when a slider moves", async ({
	page,
}) => {
	const preview = await compose(page, requests.retirement, "老後資金");
	// The chart's own wrapper; the legend icons are small `recharts-surface` SVGs too.
	const chart = preview.locator(".recharts-wrapper").first();
	await expect(chart).toBeVisible();
	const size = await chart.boundingBox();
	expect(size?.width ?? 0).toBeGreaterThan(100);
	expect(size?.height ?? 0).toBeGreaterThan(100);
	const total = statValue(preview, "退職時の資産");
	await expect(total).toContainText("¥");
	const before = await total.textContent();
	const area = await preview
		.locator(".recharts-area-area")
		.first()
		.getAttribute("d");

	const rate = preview.getByRole("slider", { name: /想定年利/ });
	await rate.focus();
	for (let step = 0; step < 4; step++) await rate.press("ArrowRight");
	await expect(total).not.toHaveText(before ?? "");
	await expect
		.poll(() =>
			preview.locator(".recharts-area-area").first().getAttribute("d"),
		)
		.not.toBe(area);
	// The yearly table follows the same series.
	await expect(preview.getByRole("table").first()).toContainText("歳");
	expect(await violations(page)).toEqual([]);
});

test("the calculator's result feeds the triangulation formula", async ({
	page,
}) => {
	const preview = await compose(page, requests.triangulation, "三角測量");
	// Step 2 is shown only once the baseline is worked out.
	await expect(preview.getByText("ステップ2 月までの距離")).toHaveCount(0);
	const calculator = preview.getByRole("group", { name: "電卓" });
	await expect(calculator).toContainText("sin(45)");
	await calculator.getByRole("button", { name: "=", exact: true }).click();
	await expect(preview.getByText("ステップ2 月までの距離")).toBeVisible();
	const formula = preview.locator("figure").filter({ hasText: "ステップ2" });
	await expect(formula.locator(".katex").first()).toBeVisible();
	await expect(formula).toContainText(/= [\d,]+ km/);
	expect(await violations(page)).toEqual([]);
});

test("slides keep the input of a scene and share its value with the next", async ({
	page,
}) => {
	const preview = await compose(page, requests.slides, "数を入れる");
	const count = preview.getByRole("spinbutton", { name: "個数" });
	await count.fill("5");
	await count.blur();
	await preview.getByRole("button", { name: "次へ" }).click();
	await expect(statValue(preview, "2倍")).toHaveText(/10/);
	await preview.getByRole("button", { name: "前へ" }).click();
	await expect(count).toHaveValue("5");
});

test("numbers and formulas stay readable in the dark theme", async ({
	page,
}) => {
	const preview = await compose(page, requests.triangulation, "三角測量");
	await preview
		.getByRole("group", { name: "電卓" })
		.getByRole("button", { name: "=", exact: true })
		.click();
	await page.evaluate(() => {
		document.documentElement.dataset.theme = "dark";
	});
	/** WCAG contrast of an element's text against the first opaque background behind it. */
	const contrast = (target: Locator) =>
		target.evaluate((element) => {
			const canvas = document.createElement("canvas");
			canvas.width = canvas.height = 1;
			const context = canvas.getContext("2d", { willReadFrequently: true })!;
			const rgba = (color: string) => {
				context.clearRect(0, 0, 1, 1);
				context.fillStyle = "#000";
				context.fillStyle = color;
				context.fillRect(0, 0, 1, 1);
				return [...context.getImageData(0, 0, 1, 1).data];
			};
			const opaque = (color: string) => {
				const probe = document.createElement("canvas").getContext("2d")!;
				probe.fillStyle = "rgba(0,0,0,0)";
				probe.fillStyle = color;
				return (
					!/^rgba\(.*,\s*0\)$/.test(probe.fillStyle) && color !== "transparent"
				);
			};
			let node: HTMLElement | null = element as HTMLElement;
			let background = "rgb(255,255,255)";
			while (node) {
				const value = getComputedStyle(node).backgroundColor;
				if (opaque(value)) {
					background = value;
					break;
				}
				node = node.parentElement;
			}
			const luminance = ([r, g, b]: number[]) => {
				const channel = (c: number) => {
					const v = c / 255;
					return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
				};
				return (
					0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!)
				);
			};
			const text = luminance(rgba(getComputedStyle(element).color));
			const back = luminance(rgba(background));
			return (Math.max(text, back) + 0.05) / (Math.min(text, back) + 0.05);
		});
	const formula = preview.locator("figure").filter({ hasText: "ステップ2" });
	expect(
		await contrast(formula.locator(".katex").first()),
	).toBeGreaterThanOrEqual(4.5);
	expect(
		await contrast(statValue(preview, "実際の平均距離との差")),
	).toBeGreaterThanOrEqual(4.5);
	expect(
		await contrast(preview.getByText("ステップ1 基線ABの長さ（km）")),
	).toBeGreaterThanOrEqual(4.5);
});
