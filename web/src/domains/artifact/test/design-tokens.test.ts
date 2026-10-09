import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	designTokens,
	designThemes,
	resolveDesignTokens,
	validDesignToken,
	designTokenAliases,
} from "../designTokens";

const defaults = {
	theme: "light",
	density: "comfortable",
	tablet: false,
	radius: "0.5rem",
	overrides: {},
};
describe("showcase DesignSystem token catalogue", () => {
	it("covers every declared token and every theme without editing derived aliases independently", () => {
		const source = ["variables.css", "themes.css"]
			.map((name) =>
				readFileSync(`packages/design-system/src/styles/${name}`, "utf8"),
			)
			.join("\n");
		const declared = Array.from(
			new Set(
				Array.from(source.matchAll(/(--[\w-]+)\s*:/g), (match) => match[1]),
			),
		).sort();
		expect(designTokens.map((token) => token.name).sort()).toEqual(declared);
		const palettes = readFileSync(
			"packages/design-system/src/styles/themes.css",
			"utf8",
		);
		const themes = Array.from(
			new Set([
				"light",
				...Array.from(
					palettes.matchAll(/data-theme="([^"]+)"/g),
					(match) => match[1]!,
				),
			]),
		).sort();
		expect([...designThemes].sort()).toEqual(themes);
		for (const theme of designThemes) {
			const resolved = resolveDesignTokens({ ...defaults, theme });
			for (const token of designTokens)
				expect(resolved[token.name], `${theme}: ${token.name}`).toBeTruthy();
		}
		expect(designTokenAliases["--radius-md"]).toContain("max(0px");
		expect(designTokenAliases["--color-chart-1"]).toBe("var(--chart-1)");
	});
	it("resets to normal regardless of inherited density, gives touch mode priority, then individual edits", () => {
		expect(resolveDesignTokens(defaults)["--ui-component-height"]).toBe(
			"2.5rem",
		);
		expect(
			resolveDesignTokens({ ...defaults, density: "compact" })[
				"--ui-component-height"
			],
		).toBe("2rem");
		expect(
			resolveDesignTokens({ ...defaults, density: "spacious" })[
				"--ui-component-height"
			],
		).toBe("3rem");
		const touch = resolveDesignTokens({
			...defaults,
			density: "spacious",
			tablet: true,
		});
		expect(touch["--ui-touch-target-min"]).toBe("44px");
		expect(touch["--ui-component-height"]).toBe("2.75rem");
		expect(
			resolveDesignTokens({
				...defaults,
				tablet: true,
				radius: "0rem",
				overrides: { "--ui-component-height": "52px", "--radius": "12px" },
			})["--radius"],
		).toBe("12px");
	});
	it("rejects incomplete, negative or unitless lengths before they can break the sample", () => {
		const radius = designTokens.find((token) => token.name === "--radius")!;
		for (const value of ["", "1", "-2px", "NaNrem", "red", "0.5r"])
			expect(validDesignToken(radius, value)).toBe(false);
		for (const value of ["0px", "0rem", ".5rem", "12px", "1.2em"])
			expect(validDesignToken(radius, value)).toBe(true);
	});
});
