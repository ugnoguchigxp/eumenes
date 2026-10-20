import { z } from "zod";
/** Both browser views share the same source contract inside the ArtifactPanel. */
export function browserViews(
	source: z.ZodString,
	title: z.ZodOptional<z.ZodString>,
) {
	return {
		"browser-settings": {
			name: "BrowserSettings",
			label: "ブラウザの設定",
			schema: z.strictObject({
				view: z.literal("browser-settings"),
				source,
				title,
			}),
		},
		"browser-workspace": {
			name: "BrowserWorkspace",
			label: "ブラウザのScript・進捗",
			schema: z.strictObject({
				view: z.literal("browser-workspace"),
				source,
				title,
			}),
		},
	} as const;
}
