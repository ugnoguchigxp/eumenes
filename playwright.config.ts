import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: "tests/browser",
	timeout: 30000,
	use: { browserName: "chromium", headless: true },
});
