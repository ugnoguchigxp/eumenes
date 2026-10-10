import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	END,
	entryOf,
	generate,
	renderDomainTable,
	replaceBlock,
	START,
} from "./domain-docs";

const graph = {
	alpha: {
		backend: "api/domains/alpha",
		web: null,
		components: null,
		depends: { api: [], web: [], test: [] },
	},
	beta: {
		backend: "api/domains/beta",
		web: "web/src/domains/beta",
		components: "web/src/components/domains/beta",
		depends: { api: ["alpha"], web: ["alpha"], test: ["gamma"] },
	},
};
const exists = (path: string) =>
	path === "api/domains/alpha/index.ts" ||
	path === "web/src/domains/beta/index.tsx";

test("entryOf prefers index.ts, then index.tsx, then the directory", () => {
	expect(entryOf("api/domains/alpha", exists)).toBe(
		"`api/domains/alpha/index.ts`",
	);
	expect(entryOf("web/src/domains/beta", exists)).toBe(
		"`web/src/domains/beta/index.tsx`",
	);
	expect(entryOf("api/domains/beta", exists)).toBe("`api/domains/beta/`");
	expect(entryOf(null, exists)).toBe("なし");
});

test("renderDomainTable lists every domain with its dependencies", () => {
	const lines = renderDomainTable(graph, exists).split("\n");
	expect(lines).toHaveLength(2 + 2);
	expect(lines[2]).toBe(
		"| `alpha` | `api/domains/alpha/index.ts` | なし | なし | なし | なし | なし |",
	);
	expect(lines[3]).toContain("`alpha` | `alpha` | `gamma` |");
});

test("replaceBlock rewrites only the marked block and requires both markers", () => {
	const doc = `before\n${START}\nold\n${END}\nafter\n`;
	expect(replaceBlock(doc, "new")).toBe(
		`before\n${START}\nnew\n${END}\nafter\n`,
	);
	expect(() => replaceBlock("no markers", "x")).toThrow(
		"domain_docs_markers_missing",
	);
});

test("docs/domains.md is up to date with scripts/domains.ts", () => {
	const doc = readFileSync(join(import.meta.dir, "../docs/domains.md"), "utf8");
	expect(generate(doc)).toBe(doc);
});
