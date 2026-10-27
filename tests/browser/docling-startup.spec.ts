import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import bundle from "../../api/domains/capabilities/bundles/docling-desk.bundle.json" with { type: "json" };

let build: string;
const publicOrigin = "http://localhost:28765";
const status = { revision: 1, configured: true, publicOrigin };
const evidence = "spec/verification/docling-on-demand-2026-10-27";
test.beforeAll(() => {
	build = mkdtempSync(join(tmpdir(), "eumenes-docling-startup-"));
	execFileSync(
		"bun",
		[
			"build",
			"tests/browser/fixtures/docling.tsx",
			"--target=browser",
			"--format=iife",
			"--minify",
			"--define",
			'process.env.NODE_ENV="production"',
			`--outdir=${build}`,
		],
		{ stdio: "pipe" },
	);
	mkdirSync(evidence, { recursive: true });
});
test.afterAll(() => rmSync(build, { recursive: true, force: true }));

for (const scenario of [
	"ready",
	"startup-failed",
	"status-failed",
	"popup-blocked",
] as const) {
	test(`on-demand artifact: ${scenario}`, async ({ page, context }) => {
		let starts = 0,
			tickets = 0,
			reads = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await context.route("**/*", async (route) => {
			const url = new URL(route.request().url());
			if (url.origin === publicOrigin)
				return route.fulfill({
					contentType: "text/html; charset=utf-8",
					body: "<h1>文書ライブラリ（fixture）</h1>",
				});
			if (url.pathname === "/api/docling/status") {
				reads++;
				if (scenario === "status-failed" && reads === 1)
					return route.fulfill({
						status: 503,
						json: { error: "fixture_unavailable" },
					});
				return route.fulfill({ json: status });
			}
			if (url.pathname === "/api/docling/ready") {
				starts++;
				await gate;
				if (scenario === "startup-failed" && starts === 1)
					return route.fulfill({
						status: 502,
						json: { error: "docling_auth_failed" },
					});
				return route.fulfill({ json: status });
			}
			if (url.pathname === "/api/docling/ui-tickets") {
				tickets++;
				return route.fulfill({
					json: {
						url: `${publicOrigin}/auth/exchange?ticket=${"f".repeat(43)}`,
						expiresIn: 60,
					},
				});
			}
			if (url.pathname.startsWith("/api/toolchain-artifacts/"))
				return route.fulfill({
					json: {
						artifact: bundle.artifacts.at(-1),
						artifactRevisionId: "artifact:docling.workspace@2",
						digest: "fixture",
						scopeRef: "scope:fixture",
					},
				});
			return route.fulfill({
				contentType: "text/html",
				body: '<!doctype html><html lang="ja" data-theme="dark"><meta charset="utf-8"><div id="root"></div></html>',
			});
		});
		if (scenario === "popup-blocked")
			await page.addInitScript(() => {
				window.open = () => null;
			});
		await page.setViewportSize({ width: 900, height: 680 });
		await page.goto("http://127.0.0.1:4444/");
		await page.addStyleTag({
			content: readFileSync(
				"packages/design-system/dist/design-system.css",
				"utf8",
			),
		});
		await page.addStyleTag({
			content:
				"body{background:var(--background);color:var(--foreground);font-family:system-ui}main{max-width:600px;padding:32px}h1{font-size:20px}.aui-stack,.aui-layout{display:grid;gap:24px}",
		});
		await page.addScriptTag({ path: join(build, "docling.js") });
		await expect(
			page.getByRole("heading", {
				name: "文章ナレッジベース管理",
				exact: true,
			}),
		).toBeVisible();
		if (scenario === "status-failed") {
			await expect(page.getByRole("alert")).toContainText(
				"接続情報を取得できません",
			);
			expect(starts).toBe(0);
			await page.getByRole("button", { name: "起動を再試行" }).click();
		}
		await expect(
			page.getByRole("button", { name: "起動を準備しています…" }),
		).toBeDisabled();
		await expect.poll(() => starts).toBe(1);
		expect(tickets).toBe(0);
		expect(context.pages()).toHaveLength(1);
		if (scenario === "ready")
			await page.screenshot({ path: `${evidence}/preparing.png` });
		release();
		const open = page.getByRole("button", {
			name: "文章ナレッジベース管理を開く",
		});
		if (scenario === "startup-failed") {
			await expect(page.getByRole("alert")).toContainText(
				"認証を確認できません",
			);
			await expect(open).toBeDisabled();
			expect(starts).toBe(1);
			await page.getByRole("button", { name: "起動を再試行" }).click();
			await expect.poll(() => starts).toBe(2);
		}
		await expect(open).toBeEnabled();
		expect(tickets).toBe(0);
		if (scenario === "ready")
			await page.screenshot({ path: `${evidence}/ready.png` });
		if (scenario === "popup-blocked") {
			await open.click();
			await expect(page.getByRole("alert")).toContainText("別タブを開けません");
			expect(tickets).toBe(0);
		} else {
			const popupPending = page.waitForEvent("popup");
			await open.click();
			const popup = await popupPending;
			await expect(
				popup.getByRole("heading", { name: "文書ライブラリ（fixture）" }),
			).toBeVisible();
			expect(tickets).toBe(1);
			await popup.close();
		}
	});
}
