import { expect, test } from "bun:test";
import { allSourceFiles, checkSource, unusedDependencies } from "./boundaries";
import { closure, dependsOf } from "./domains";

const check = (name: string, spec: string) =>
	checkSource(name, `import { x } from "${spec}";`);

test("application may use a domain public entry and contracts only", () => {
	expect(check("api/application/a.ts", "../domains/coding")).toEqual([]);
	expect(check("api/application/a.ts", "../domains/coding/index")).toEqual([]);
	expect(check("api/application/a.ts", "../domains/coding/contracts")).toEqual(
		[],
	);
	expect(
		check("api/application/a.ts", "../domains/coding/contracts/index"),
	).toEqual([]);
	expect(check("api/application/a.ts", "../domains/coding/adapters")).toEqual([
		"api/application/a.ts: application must use coding public entry (../domains/coding/adapters)",
	]);
	expect(
		check("api/application/a.ts", "../domains/coding/service"),
	).toHaveLength(1);
	expect(check("api/application/a.ts", "../infrastructure/sqlite")).toEqual([]);
});

test("application tests and fixtures may also use domain test helpers", () => {
	for (const name of [
		"api/application/a.test.ts",
		"api/application/a.fixture.ts",
	])
		expect(check(name, "../domains/coding/test/harness")).toEqual([]);
	expect(
		check("api/application/a.test.ts", "../domains/coding/service"),
	).toHaveLength(1);
	expect(
		check("api/application/a.ts", "../domains/coding/test/h"),
	).toHaveLength(1);
});

test("infrastructure must not import domains or application", () => {
	const message = (spec: string) =>
		`api/infrastructure/a.ts: infrastructure must not import domains/application (${spec})`;
	expect(check("api/infrastructure/a.ts", "../domains/coding")).toEqual([
		message("../domains/coding"),
	]);
	expect(check("api/infrastructure/a.ts", "../application/app")).toEqual([
		message("../application/app"),
	]);
	expect(check("api/infrastructure/sqlite/a.ts", "../logger")).toEqual([]);
	expect(check("api/infrastructure/sqlite/a.ts", "./b")).toEqual([]);
});

test("path aliases are forbidden but npm packages pass", () => {
	for (const spec of ["@/x", "~/x", "api/x", "web/x"])
		expect(check("api/application/a.ts", spec)).toEqual([
			`api/application/a.ts: boundary_alias_forbidden (${spec})`,
		]);
	for (const spec of ["zod", "node:path", "@hono/zod-validator", "bun:test"])
		expect(check("api/application/a.ts", spec)).toEqual([]);
});

test("domain dependencies are checked per layer", () => {
	// conversation -> avatar is a web-only edge.
	expect(dependsOf("conversation", "api")).not.toContain("avatar");
	expect(dependsOf("conversation", "web")).toContain("avatar");
	expect(closure("conversation", "api")).not.toContain("avatar");
	expect(closure("conversation", "test")).toContain("avatar");
	expect(check("web/src/domains/conversation/a.ts", "../avatar")).toEqual([]);
	expect(check("web/src/domains/audio/a.ts", "../avatar")).toEqual([
		"web/src/domains/audio/a.ts: forbidden dependency audio -> avatar",
	]);
	// world -> memory is test-only.
	expect(check("api/domains/world/service/a.ts", "../../memory")).toContain(
		"api/domains/world/service/a.ts: forbidden dependency world -> memory",
	);
	expect(check("api/domains/world/test/a.ts", "../../memory")).toEqual([]);
});

test("unused dependency detection", () => {
	// With no files every declared edge is unused.
	expect(unusedDependencies([])).toContain(
		"unused dependency task-reports -> tasks (api)",
	);
	expect(unusedDependencies(allSourceFiles())).toEqual([]);
});

test("web and client reach world only through contracts/view", () => {
	for (const name of ["web/src/domains/world/p.ts", "client/world.ts"]) {
		const up = name.startsWith("web") ? "../../../../api" : "../api";
		expect(check(name, `${up}/domains/world/contracts/view`)).toEqual([]);
		expect(check(name, `${up}/domains/world/contracts`)).toHaveLength(1);
		expect(check(name, `${up}/domains/world/contracts/index`)).toHaveLength(1);
		expect(check(name, `${up}/domains/world/contracts/host`)).toHaveLength(1);
	}
	expect(
		check(
			"web/src/domains/world/p.ts",
			"../../../../api/domains/conversation/contracts",
		),
	).toEqual([]);
});
