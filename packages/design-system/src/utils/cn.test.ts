import { describe, expect, it } from "vitest";
import { cn } from "./cn";

describe("density typography with semantic colors", () => {
	it("keeps foreground color when the default button uses density typography", () => {
		expect(cn("bg-primary text-primary-foreground text-sm", "text-ui")).toBe(
			"bg-primary text-primary-foreground text-ui",
		);
	});
	it("allows caller overrides of font size and color independently", () => {
		expect(cn("text-primary-foreground text-ui", "text-lg")).toBe(
			"text-primary-foreground text-lg",
		);
		expect(cn("text-primary-foreground text-ui", "text-destructive")).toBe(
			"text-ui text-destructive",
		);
	});
});
