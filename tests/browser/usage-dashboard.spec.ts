import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	readdirSync,
	mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
let build: string;
test.beforeAll(() => {
	build = mkdtempSync(join(tmpdir(), "eumenes-usage-ui-"));
	execFileSync(
		"bun",
		[
			"--eval",
			`import {build} from 'vite';import react from '@vitejs/plugin-react';await build({configFile:false,plugins:[react()],build:{outDir:${JSON.stringify(build)},emptyOutDir:true,rollupOptions:{input:'tests/browser/fixtures/usage-dashboard.tsx',output:{entryFileNames:'fixture.js'}}}});`,
		],
		{ stdio: "pipe" },
	);
	mkdirSync("spec/verification/usage-dashboard-2026-10-31", {
		recursive: true,
	});
});
test.afterAll(() => rmSync(build, { recursive: true, force: true }));
for (const [width, theme] of [
	[900, "dark"],
	[390, "dark"],
	[1440, "dark"],
	[900, "light"],
	[390, "light"],
	[1440, "light"],
] as const) {
	test(`registered usage artifact at ${width}px ${theme}, without a server`, async ({
		page,
	}) => {
		await page.setViewportSize({ width, height: 1000 });
		const errors: string[] = [];
		page.on("pageerror", (e) => errors.push(e.message));
		await page.route("**/*", (route) => {
			const path = new URL(route.request().url()).pathname;
			if (path === "/")
				return route.fulfill({
					contentType: "text/html",
					body: `<!doctype html><html lang="ja" data-theme="${theme}"><meta charset="utf-8"><style>body{margin:0;background:var(--background);color:var(--foreground)}</style><div id="root"></div></html>`,
				});
			try {
				return route.fulfill({
					body: readFileSync(join(build, path.slice(1))),
					contentType: path.endsWith(".css") ? "text/css" : "text/javascript",
				});
			} catch {
				return route.abort();
			}
		});
		await page.goto("http://localhost:28765/");
		for (const file of readdirSync(join(build, "assets")).filter((f) =>
			f.endsWith(".css"),
		))
			await page.addStyleTag({ url: "/assets/" + file });
		await page.addScriptTag({ type: "module", url: "/fixture.js" });
		await expect(
			page.getByRole("heading", { name: "利用状況", exact: true }),
		).toBeVisible();
		await expect(
			page.getByText("42分18秒", { exact: true }).first(),
		).toBeVisible();
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
		await page.screenshot({
			path: `spec/verification/usage-dashboard-2026-10-31/artifact-${width}-${theme}.png`,
		});
		await page.getByRole("tab", { name: "Codex SDK" }).click();
		await expect(page.locator("html")).toHaveAttribute(
			"data-query-model",
			"model-current",
		);
		await expect(page.getByRole("tab", { name: "Codex SDK" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		await page.getByRole("combobox", { name: "モデル", exact: true }).click();
		await page.getByRole("option", { name: "model-other" }).click();
		await expect(page.locator("html")).toHaveAttribute(
			"data-query-model",
			"model-other",
		);
		await expect(page.getByText("1,000 token", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "次へ", exact: true }).click();
		await expect(page.getByText("108件 · 2 / 5ページ")).toBeVisible();
		await page.getByRole("tab", { name: "料金設定" }).click();
		await page.getByLabel("単価（USD / 分）", { exact: true }).fill("0.03");
		await page
			.getByLabel("適用開始（日本時間）", { exact: true })
			.fill("2026-10-01T00:00");
		await page
			.getByLabel("出典・確認資料", { exact: true })
			.fill("Fixture pricing");
		await page.getByRole("button", { name: "入力を確認", exact: true }).click();
		await expect(page.getByText(/USD 0.03 \/ 分/)).toBeVisible();
		expect(await page.locator("html").getAttribute("data-writes")).toBeNull();
		await page
			.getByRole("button", { name: "この単価を保存", exact: true })
			.click();
		await expect(page.locator("html")).toHaveAttribute("data-writes", "1");
		await expect(
			page.getByText("Fixture pricing", { exact: true }),
		).toBeVisible();
		expect(errors).toEqual([]);
	});
}
