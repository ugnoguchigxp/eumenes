import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture } from "./fixture";

declare global {
	interface Window {
		__cspViolations: string[];
	}
}

let webPort: number;
const fixture = createFixture();
let dir: string;
test.beforeAll(async () => {
	const apiPort = await fixture.port();
	webPort = await fixture.port();
	dir = mkdtempSync(join(tmpdir(), "eumenes-csp-"));
	await fixture.launch(
		["scripts/toolchain-fixture-server.ts"],
		{
			EUMENES_PORT: String(apiPort),
			EUMENES_ORIGIN: `http://127.0.0.1:${webPort}`,
		},
		{ ports: [apiPort] },
	);
	await fixture.launchWeb({
		webPort,
		apiPort,
		token: "fixture-token-for-toolchain-browser",
		cacheDir: join(dir, "vite-cache"),
	});
	await fixture.waitUntil(
		async () => (await fetch(`http://127.0.0.1:${webPort}`)).ok,
		{ message: "csp fixture unavailable" },
	);
});
test.afterAll(async () => {
	await fixture.stopAll();
	rmSync(dir, { recursive: true, force: true });
});

test("the SPA policy is sent and the main screens raise no CSP violation", async ({
	page,
}) => {
	await page.addInitScript(() => {
		Object.defineProperty(window, "WebGL2RenderingContext", {
			value: undefined,
		});
		window.__cspViolations = [];
		document.addEventListener("securitypolicyviolation", (e) =>
			window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`),
		);
	});
	const response = await page.goto(`http://127.0.0.1:${webPort}/`);
	const csp = response?.headers()["content-security-policy"] ?? "";
	expect(csp).toContain("default-src 'self'");
	expect(csp).toContain("frame-ancestors 'none'");
	await expect(page.locator("#root")).not.toBeEmpty();
	// Conversation (initial screen), the artifact showcase, then settings.
	await page
		.getByRole("button", { name: "UIショーケース", exact: true })
		.click();
	await expect(
		page.getByRole("region", { name: "UIショーケース", exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "設定", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "取得先と手順" }),
	).toBeVisible();
	const violations = await page.evaluate(() => window.__cspViolations);
	// zod 4 probes `new Function("")` once and swallows the CSP failure (it only
	// disables its JIT); the browser still reports it. No other code uses eval.
	expect(violations.filter((v) => v !== "script-src eval")).toEqual([]);
});
