import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type CompositionModelDefinition,
	computeValues,
} from "@eumenes/artifact-ui/composition-checks";
import { parseDefinition } from "@eumenes/artifact-ui/contracts";
import { validatedDefinition } from "../contracts";

/**
 * Acceptance fixtures U1–U8 of the UI studio's expressive parts (spec/ui-studio-expressive-parts-
 * implementation-plan-2026-10-17.md §8.3): one finished definition each, U5 as an airplane
 * diagram (a) and a triangulation (b). They must parse, stay within the limits, and reference
 * only names their model declares. The SKILL's own examples are held to the same rules.
 */
const fixtureDir = join(import.meta.dir, "fixtures");
const names = readdirSync(fixtureDir)
	.filter((name) => name.endsWith(".json"))
	.sort();
const limits = { bytes: 16_384, parts: 60, depth: 4, children: 12 };
const bundlePath = join(
	import.meta.dir,
	"../../capabilities/bundles/ui-compositions.bundle.json",
);

type Node = Record<string, unknown> & { view: string; children?: Node[] };
const nodes = (root: Node, depth = 1): Array<{ node: Node; depth: number }> => [
	{ node: root, depth },
	...(root.children ?? []).flatMap((child) => nodes(child, depth + 1)),
];
/** The artifact parser's verdict as a short string ("" when accepted). */
function parseVerdict(definition: unknown): string {
	try {
		parseDefinition(JSON.stringify(definition));
		return "";
	} catch (error) {
		return String(error instanceof Error ? error.message : error).slice(0, 300);
	}
}
const bytes = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value)).length;

/** Names a part refers to, with the model entry kind each must have. */
function references(
	node: Node,
): Array<[string, "number" | "text" | "boolean" | "series"]> {
	const refs: Array<[string, "number" | "text" | "boolean" | "series"]> = [];
	const add = (
		name: unknown,
		kind: "number" | "text" | "boolean" | "series",
	) => {
		if (typeof name === "string") refs.push([name, kind]);
	};
	switch (node.view) {
		case "number-input":
		case "slider":
			add(node.bind, "number");
			break;
		case "stepper":
			add(node.bind, "number");
			break;
		case "diagram":
			add(node.stepBind, "number");
			break;
		case "calculator":
			add(node.resultBind, "number");
			break;
		case "choice":
			add(node.bind, "text");
			break;
		case "toggle":
			add(node.bind, "boolean");
			break;
		case "data-table":
			add(node.series, "series");
			break;
		case "chart":
			for (const series of (node.series as Array<{ from?: string }>) ?? [])
				add(series.from, "series");
			break;
	}
	return refs;
}
function checkModelReferences(root: Node) {
	const model = root.model as
		| {
				state?: Record<string, { type: string }>;
				computed?: Record<string, unknown>;
		  }
		| undefined;
	const states = model?.state ?? {};
	const computed = model?.computed ?? {};
	for (const name of Object.keys(states))
		expect(Object.hasOwn(computed, name)).toBe(false);
	for (const { node } of nodes(root))
		for (const [name, kind] of references(node)) {
			if (kind === "series") {
				const entry = computed[name] as { series?: unknown } | undefined;
				expect(entry && typeof entry === "object" && "series" in entry).toBe(
					true,
				);
			} else {
				expect(states[name]?.type).toBe(kind);
			}
		}
}
function checkLimits(definition: Node) {
	expect(bytes(definition)).toBeLessThanOrEqual(limits.bytes);
	const all = nodes(definition);
	expect(all.length).toBeLessThanOrEqual(limits.parts);
	for (const { node, depth } of all) {
		expect(depth).toBeLessThanOrEqual(limits.depth);
		expect((node.children ?? []).length).toBeLessThanOrEqual(limits.children);
		expect("source" in node).toBe(false);
		if (node !== definition) expect("model" in node).toBe(false);
		for (const key of ["tabs", "headerChildren", "draftSource"])
			expect(key in node).toBe(false);
	}
	expect(
		all.filter(({ node }) => node.view === "form").length,
	).toBeLessThanOrEqual(1);
	expect(definition.view).toBe("layout");
}

test("U1–U8 fixtures exist (U5 as two)", () => {
	expect(names.map((name) => name.split("-")[0])).toEqual([
		"u1",
		"u2",
		"u3",
		"u4",
		"u5a",
		"u5b",
		"u6",
		"u7",
		"u8",
	]);
});

describe.each(names)("fixture %s", (name) => {
	const raw = readFileSync(join(fixtureDir, name), "utf8");
	const definition = JSON.parse(raw) as Node;

	test("stays within 16 KiB, 60 parts and 4 levels, with no source or settings keys", () => {
		checkLimits(definition);
	});
	test("binds and series names point to the matching state or computed series", () => {
		checkModelReferences(definition);
	});
	test("parses as an artifact definition", () => {
		expect(parseVerdict(definition)).toBe("");
	});
	test("is accepted by the studio's validation", () => {
		expect(validatedDefinition(definition).definition).toEqual(definition);
	});
	test("every computed value has a value at the initial state", () => {
		const model = definition.model as CompositionModelDefinition | undefined;
		if (!model) return;
		const states = new Map(
			Object.entries(model.state ?? {}).map(([key, state]) => [
				key,
				state.initial,
			]),
		);
		const values = computeValues(model, states);
		for (const key of Object.keys(model.computed ?? {}))
			expect([key, values.get(key) ?? null]).not.toEqual([key, null]);
	});
});

test("the sums and totals of the fixtures are written as expressions, not typed in", () => {
	for (const name of names) {
		const definition = JSON.parse(
			readFileSync(join(fixtureDir, name), "utf8"),
		) as Node;
		for (const { node } of nodes(definition))
			if (node.view === "stat") {
				// A fixed `value` is for facts that never change; a stat with a model reacts through `expr`.
				const model = definition.model as object | undefined;
				if (model) expect(node.value).toBeUndefined();
			}
	}
});

describe("ui.studio revisions", () => {
	const bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as {
		definitions: Array<Record<string, unknown> & { kind: string; id: string }>;
	};
	const find = (kind: string, id: string) =>
		bundle.definitions.find((d) => d.kind === kind && d.id === id)!;
	const skill = find("skill", "ui.studio");
	const body = String(skill.body);

	test("skill@5, package@5 and toolchain@7 refer to each other", () => {
		expect(skill.revision).toBe(5);
		const pkg = find("package", "ui.studio");
		expect(pkg.revision).toBe(5);
		expect(pkg.dependencies).toContain("skill:ui.studio@5");
		expect(pkg.requiredSkillRevisionIds).toEqual(["skill:ui.studio@5"]);
		const toolchain = find("toolchain", "ui.compose");
		expect(toolchain.revision).toBe(7);
		expect(toolchain.packageRevisionId).toBe("package:ui.studio@5");
		expect(toolchain.dependencies).toEqual(["package:ui.studio@5"]);
		expect(find("profile", "ui.studio").revision).toBe(1);
	});
	test("the SKILL body is within 48 KB", () => {
		expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(
			48 * 1024,
		);
	});
	test("every example of the SKILL parses, stays within the limits and passes the studio's validation", () => {
		const examples = body
			.split("\n")
			.filter((line) => line.startsWith('{"title"'))
			.map((line) => JSON.parse(line) as { title: string; definition: Node });
		expect(examples.length).toBeGreaterThanOrEqual(7);
		for (const { title, definition } of examples) {
			expect(title.length).toBeGreaterThan(0);
			checkLimits(definition);
			checkModelReferences(definition);
			expect(parseVerdict(definition)).toBe("");
			expect(validatedDefinition(definition).definition).toEqual(definition);
		}
	});
});
