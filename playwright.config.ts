import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: "tests/browser",
	timeout: 30000,
	// Each spec file owns heavy backend and Vite processes; run one at a time.
	workers: 1,
	retries: process.env.CI ? 1 : 0,
	reporter: [
		["list"],
		["html", { open: "never" }],
		["json", { outputFile: "test-results/playwright.json" }],
	],
	// Deferred WebGL and fixture requests can take longer than the 5s default.
	expect: { timeout: 20000 },
	use: { browserName: "chromium", headless: true },
});
