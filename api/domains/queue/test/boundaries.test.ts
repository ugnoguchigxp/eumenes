import { expect, test } from "bun:test";
import { closure, domains } from "../../../../scripts/domains";

test("queue and scheduler declare only their real dependencies", () => {
	expect(domains.queue.depends).toEqual({ api: [], web: [], test: [] });
	expect(domains.scheduler.depends.api).toEqual(["queue"]);
	expect(closure("queue")).toEqual(["queue"]);
	expect(closure("scheduler")).toEqual(["queue", "scheduler"]);
	expect(domains.dialogue.depends.api).toContain("queue");
	expect(domains.dialogue.depends.api).toContain("scheduler");
	expect(closure("voice-dialogue")).toContain("queue");
});

test("a dependency cycle stops with an explicit error", () => {
	const cyclic = {
		queue: { depends: { api: ["scheduler"], web: [], test: [] } },
		scheduler: { depends: { api: ["queue"], web: [], test: [] } },
	};
	expect(() => closure("queue", "api", cyclic)).toThrow(
		"domain_dependency_cycle",
	);
});

import { checkSource } from "../../../../scripts/boundaries";

test("export-from, dynamic import and import types are checked like imports", () => {
	const file = "api/domains/dialogue/service/x.ts";
	expect(
		checkSource(file, 'export * from "../../memory/service/journal";'),
	).toEqual([
		`${file}: import ../../memory/service/journal bypasses memory public entry`,
	]);
	expect(
		checkSource(
			file,
			'const m = await import("../../memory/service/journal");',
		),
	).toHaveLength(1);
	expect(
		checkSource(file, 'type T = import("../../memory/service/journal").X;'),
	).toHaveLength(1);
	expect(checkSource(file, "const m = await import(name);")).toEqual([
		`${file}: boundary_dynamic_specifier`,
	]);
	// Public entries and declared dependencies stay legal.
	expect(checkSource(file, 'export * from "../../memory";')).toEqual([]);
	expect(
		checkSource(file, 'import type { X } from "../../memory/contracts";'),
	).toEqual([]);
});

test("an undeclared dependency through export-from is rejected", () => {
	const file = "api/domains/delivery/service/x.ts";
	expect(checkSource(file, 'export { a } from "../../memory";')).toEqual([
		`${file}: forbidden dependency delivery -> memory`,
	]);
});

test("a declared re-export (service-tests contracts → larm) is legal", () => {
	expect(
		checkSource(
			"api/domains/service-tests/contracts/index.ts",
			'export * from "../../larm/contracts";',
		),
	).toEqual([]);
});

test("web and client may reach api only through domain contracts", () => {
	const web = "web/src/components/Foo.tsx";
	expect(
		checkSource(web, 'import { a } from "../../../api/domains/delivery";'),
	).toHaveLength(1);
	expect(
		checkSource(
			web,
			'import { a } from "../../../api/domains/delivery/service";',
		),
	).toHaveLength(1);
	expect(
		checkSource(
			web,
			'import { a } from "../../../api/domains/delivery/contracts";',
		),
	).toEqual([]);
	expect(
		checkSource("client/x.ts", 'import { a } from "../api/domains/memory";'),
	).toHaveLength(1);
	expect(
		checkSource(
			"client/x.ts",
			'import { a } from "../api/domains/memory/contracts";',
		),
	).toEqual([]);
	// Tests may wire real services.
	expect(
		checkSource(
			"web/src/x.test.ts",
			'import { a } from "../../api/domains/delivery";',
		),
	).toEqual([]);
});

test("cli may use client, contracts and auth-config only", () => {
	expect(checkSource("cli/x.ts", 'import { a } from "../client";')).toEqual([]);
	expect(
		checkSource(
			"cli/x.ts",
			'import { a } from "../api/infrastructure/auth-config";',
		),
	).toEqual([]);
	expect(
		checkSource(
			"cli/x.ts",
			'import { a } from "../api/domains/dialogue/contracts";',
		),
	).toEqual([]);
	expect(
		checkSource(
			"cli/x.ts",
			'import { a } from "../api/infrastructure/sqlite";',
		),
	).toHaveLength(1);
	expect(
		checkSource("cli/x.ts", 'import { a } from "../web/src/App";'),
	).toHaveLength(1);
});
