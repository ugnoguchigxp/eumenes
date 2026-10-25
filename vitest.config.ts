import { defineConfig } from "vitest/config";
export default defineConfig({
	test: {
		environment: "jsdom",
		include: ["web/src/**/*.test.{ts,tsx}", "client/**/*.test.ts"],
		setupFiles: ["web/src/domains/audio/test/speech-classifier.setup.ts"],
	},
});
