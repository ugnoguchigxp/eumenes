import { defineConfig } from "vitest/config";
export default defineConfig({
	test: {
		environment: "jsdom",
		include: ["web/src/**/*.test.{ts,tsx}"],
		// Raw CSS is token data for the showcase, not a stylesheet mock.
		css: { include: [/\?raw$/] },
	},
});
