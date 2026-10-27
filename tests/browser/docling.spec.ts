import { createServer, type Server } from "node:http";
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import bundle from "../../api/domains/capabilities/bundles/docling-desk.bundle.json" with { type: "json" };

let build: string;
let gateway: Server;
let publicOrigin: string;
test.beforeAll(async () => {
	gateway = createServer((req, res) => {
		if (new URL(req.url!, "http://localhost").pathname === "/auth/exchange") {
			res.writeHead(303, {
				Location: "/",
				"Set-Cookie":
					"docling_fixture=authenticated; Path=/; Secure; HttpOnly; SameSite=None",
			});
			res.end();
			return;
		}
		res.writeHead(
			req.headers.cookie?.includes("docling_fixture=authenticated") ? 200 : 401,
			{ "Content-Type": "text/html; charset=utf-8" },
		);
		res.end(
			req.headers.cookie?.includes("docling_fixture=authenticated")
				? "<h1>Docling文書ライブラリ（fixture）</h1>"
				: "unauthorized",
		);
	});
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const address = gateway.address();
	if (!address || typeof address === "string")
		throw new Error("fixture_address_invalid");
	publicOrigin = `http://localhost:${address.port}`;
	build = mkdtempSync(join(tmpdir(), "eumenes-docling-browser-"));
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
});
test.afterAll(async () => {
	await new Promise<void>((resolve, reject) =>
		gateway.close((e) => (e ? reject(e) : resolve())),
	);
	rmSync(build, { recursive: true, force: true });
});

for (const scenario of ["success", "auth-failed", "popup-blocked"] as const) {
	test(`Docling separate tab: ${scenario}`, async ({ page, context }) => {
		page.on("pageerror", (error) =>
			console.log("fixture page error:", error.message),
		);
		let posts = 0;
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		await context.route("http://127.0.0.1:4444/**", async (route) => {
			const path = new URL(route.request().url()).pathname;
			if (path === "/api/docling/status")
				return route.fulfill({
					json: {
						revision: 1,
						configured: true,
						publicOrigin,
					},
				});
			if (path === "/api/docling/ready")
				return route.fulfill({
					json: { revision: 1, configured: true, publicOrigin },
				});
			if (path === "/api/docling/ui-tickets") {
				posts++;
				await gate;
				return scenario === "auth-failed"
					? route.fulfill({
							status: 502,
							json: { error: "docling_auth_failed" },
						})
					: route.fulfill({
							json: {
								url: `${publicOrigin}/auth/exchange?ticket=${"f".repeat(43)}`,
								expiresIn: 60,
							},
						});
			}
			if (path.startsWith("/api/toolchain-artifacts/"))
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
		const button = page.getByRole("button", {
			name: "文章ナレッジベース管理を開く",
		});
		await expect(button).toBeVisible();
		await expect(
			page.getByText("共通ライブラリ", { exact: true }),
		).toBeVisible();
		expect(posts).toBe(0);
		await expect(page.locator("iframe")).toHaveCount(0);
		if (scenario === "success") {
			mkdirSync("spec/verification/docling-desk-2026-10-25", {
				recursive: true,
			});
			await page.screenshot({
				path: "spec/verification/docling-desk-2026-10-25/fixture-artifact.png",
			});
			const popupPromise = page.waitForEvent("popup");
			await button.click();
			const popup = await popupPromise;
			await expect(
				page.getByRole("button", { name: "接続しています…" }),
			).toBeDisabled();
			await expect.poll(() => posts).toBe(1);
			release();
			await expect(
				popup.getByRole("heading", {
					name: "Docling文書ライブラリ（fixture）",
				}),
			).toBeVisible();
			expect(
				(await context.cookies(publicOrigin)).some(
					(c) =>
						c.name === "docling_fixture" &&
						c.secure &&
						c.httpOnly &&
						c.sameSite === "None",
				),
			).toBe(true);
			await expect(button).toBeEnabled();
			expect(posts).toBe(1);
		} else {
			release();
			await button.click();
			await expect(page.getByRole("alert")).toContainText(
				scenario === "popup-blocked"
					? "別タブを開けません"
					: "認証を確認できません",
			);
			expect(posts).toBe(scenario === "popup-blocked" ? 0 : 1);
			await expect(button).toBeEnabled();
		}
	});
}
