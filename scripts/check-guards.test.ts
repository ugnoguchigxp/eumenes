import { expect, test } from "bun:test";
import { parseGuardScope } from "./check-guards";
import { unownedApplicationFiles } from "./domain-docs";
import { partition } from "./verification-static";

test("parseGuardScope defaults to --all and includes applicationPaths for domain selections", () => {
	expect(parseGuardScope([])).toEqual({ all: true, domains: [], paths: [] });
	const dialogueScope = parseGuardScope(["--domain", "dialogue"]);
	expect(dialogueScope.all).toBe(false);
	expect(dialogueScope.domains).toEqual(["dialogue"]);
	expect(dialogueScope.paths).toContain("api/domains/dialogue");
	expect(dialogueScope.paths).toContain("api/application/agency");

	const appScope = parseGuardScope(["--domain", "application"]);
	expect(appScope.paths).toContain("api/application/server-services.ts");
	expect(appScope.paths).toContain("docs");
});

test("G1 + G2: partition fails in-scope application/bundle violations and keeps unrelated domains warning-only", () => {
	const findings = [
		{
			text: "size-budget: api/application/agency/always-on-host.ts#createAlwaysOnHost (474)",
			path: "api/application/agency/always-on-host.ts",
		},
		{
			text: "fixed-names: api/domains/capabilities/bundles/image-screen.bundle.json:171 /qwen/i",
			path: "api/domains/capabilities/bundles/image-screen.bundle.json",
		},
		{
			text: "size-budget: api/application/server-services.ts#buildServices grew 348 -> 499 (limit 300)",
			path: "api/application/server-services.ts",
		},
	];

	const timers = partition(findings, parseGuardScope(["--domain", "timers"]));
	expect(timers.failing).toEqual([]);
	expect(timers.outside).toHaveLength(3);

	const dialogue = partition(
		findings,
		parseGuardScope(["--domain", "dialogue"]),
	);
	expect(dialogue.failing).toHaveLength(1);
	expect(dialogue.failing[0]!.path).toBe(
		"api/application/agency/always-on-host.ts",
	);
	expect(dialogue.outside).toHaveLength(2);

	const capabilities = partition(
		findings,
		parseGuardScope(["--domain", "capabilities"]),
	);
	expect(capabilities.failing).toHaveLength(1);
	expect(capabilities.failing[0]!.path).toBe(
		"api/domains/capabilities/bundles/image-screen.bundle.json",
	);

	const app = partition(findings, parseGuardScope(["--domain", "application"]));
	expect(app.failing).toHaveLength(1);
	expect(app.failing[0]!.path).toBe("api/application/server-services.ts");
});

test("all api/application TS/TSX files have explicit ownership in scripts/domains.ts", () => {
	expect(unownedApplicationFiles()).toEqual([]);
});
