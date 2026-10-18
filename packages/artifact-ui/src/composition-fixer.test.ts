import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compositionDirections,
	compositionViews,
} from "./composition-contracts";
import { fixDefinition, type FixResult } from "./composition-fixer";
import { validateComposition } from "./composition-validate";
import { maxDefinitionBytes, parseDefinition } from "./contracts";

type Obj = Record<string, unknown>;
const layout = (children: unknown[], extra: Obj = {}) => ({
	view: "layout",
	children,
	...extra,
});
const block = (title = "題") => ({ view: "text-block", title });

/** Every limit of the studio: allowlist, source, settings keys, depth, parts, forms, children. */
function checkAllLimits(definition: Obj) {
	let parts = 0;
	let forms = 0;
	const settings = ["tabs", "headerChildren", "headerLayout", "draftSource"];
	const walk = (node: Obj, depth: number) => {
		parts += 1;
		expect(depth).toBeLessThanOrEqual(6);
		expect(["layout", ...compositionViews]).toContain(node.view as never);
		expect("source" in node).toBe(false);
		if (node.view === "form") forms += 1;
		if (node.view !== "layout") return;
		expect(compositionDirections as readonly unknown[]).toContain(
			node.direction ?? "stack",
		);
		for (const key of settings) expect(key in node).toBe(false);
		const children = node.children as Obj[];
		expect(children.length).toBeGreaterThan(0);
		expect(children.length).toBeLessThanOrEqual(48);
		for (const child of children) walk(child, depth + 1);
	};
	walk(definition, 1);
	expect(parts).toBeLessThanOrEqual(240);
	expect(forms).toBeLessThanOrEqual(1);
	const json = JSON.stringify(definition);
	expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(
		maxDefinitionBytes,
	);
	expect(() => parseDefinition(json)).not.toThrow();
	expect(validateComposition(definition)).toEqual({ ok: true });
}

function fixed(input: unknown): { definition: Obj; fixes: string[] } {
	const result = fixDefinition(input);
	if (!result.ok)
		throw new Error(`expected a fix, got ${result.fixes.join(", ")}`);
	checkAllLimits(result.definition);
	return result;
}
const children = (result: { definition: Obj }) =>
	result.definition.children as Obj[];

describe("identity on valid definitions", () => {
	const fixtureDir = join(
		import.meta.dir,
		"../../../api/domains/ui-compositions/test/fixtures",
	);
	const fixtures = readdirSync(fixtureDir)
		.filter((name) => name.endsWith(".json"))
		.sort();
	test("there are fixtures", () =>
		expect(fixtures.length).toBeGreaterThanOrEqual(9));
	test.each(fixtures)("fixture %s comes back unchanged", (name) => {
		const definition = JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));
		const result = fixDefinition(definition);
		expect(result).toEqual({ ok: true, definition, fixes: [] });
	});

	const bundle = JSON.parse(
		readFileSync(
			join(
				import.meta.dir,
				"../../../api/domains/capabilities/bundles/ui-compositions.bundle.json",
			),
			"utf8",
		),
	) as { definitions: Array<{ kind: string; id: string; body: string }> };
	const skill = bundle.definitions.find(
		(d) => d.kind === "skill" && d.id === "ui.studio",
	)!;
	const examples = skill.body
		.split("\n")
		.filter((line) => line.startsWith('{"baseRevision":0,"title"'))
		.map((line) => JSON.parse(line) as { title: string; content: Obj });
	test("the SKILL has examples", () =>
		expect(examples.length).toBeGreaterThanOrEqual(7));
	test("every SKILL example comes back unchanged", () => {
		for (const { content: definition } of examples)
			expect(fixDefinition(definition)).toEqual({
				ok: true,
				definition,
				fixes: [],
			});
	});
	test("a valid definition is not mutated and the result is a copy", () => {
		const definition = layout([block()], { direction: "grid" });
		const snapshot = structuredClone(definition);
		const result = fixed(definition);
		expect(definition).toEqual(snapshot);
		expect(result.definition).not.toBe(definition);
	});
});

describe("outer shape", () => {
	test("an array of parts is wrapped in a stack layout", () => {
		const result = fixed([block("a"), block("b")]);
		expect(result.definition).toEqual(
			layout([block("a"), block("b")], { direction: "stack" }),
		);
		expect(result.fixes).toEqual(["wrap_root"]);
	});
	test("a single non-layout part is wrapped", () => {
		const result = fixed(block());
		expect(result.definition.view).toBe("layout");
		expect(children(result)).toEqual([block()]);
		expect(result.fixes).toEqual(["wrap_root"]);
	});
	test("a double wrap is unwrapped", () => {
		const result = fixed({ definition: { definition: layout([block()]) } });
		expect(result.definition).toEqual(layout([block()]));
		expect(result.fixes).toEqual(["unwrap_definition", "unwrap_definition"]);
	});
	test("an unwrapped array is wrapped too", () => {
		const result = fixed({ definition: [block()] });
		expect(result.fixes).toEqual(["unwrap_definition", "wrap_root"]);
	});
	test("an aliased root layout is not wrapped", () => {
		const result = fixed({ view: "container", children: [block()] });
		expect(result.definition.view).toBe("layout");
		expect(result.fixes).toEqual(["alias:.:container->layout"]);
	});
});

describe("keys", () => {
	test("source and settings-only layout keys are removed", () => {
		const result = fixed(
			layout([{ ...block(), source: "x" }], {
				tabs: [{ label: "a", children: [0] }],
				headerChildren: [0],
				headerLayout: "inline",
				draftSource: "x",
			}),
		);
		expect(result.fixes).toEqual([
			"drop_key:.:tabs",
			"drop_key:.:headerChildren",
			"drop_key:.:headerLayout",
			"drop_key:.:draftSource",
			"drop_key:children/0:source",
		]);
		expect(result.definition).toEqual(layout([block()]));
	});
	test("unknown keys of a part are dropped", () => {
		const result = fixed(layout([{ ...block(), subtitle: "x", extra: 1 }]));
		expect(result.fixes).toEqual([
			"drop_key:children/0:subtitle",
			"drop_key:children/0:extra",
		]);
	});
	test("unknown keys inside nested objects are dropped", () => {
		const result = fixed(
			layout([
				{ view: "faq", items: [{ question: "q", answer: "a", note: "n" }] },
			]),
		);
		expect(result.fixes).toEqual(["drop_key:children/0/items/0:note"]);
	});
	test("an unknown key of a layout is dropped", () => {
		const result = fixed(layout([block()], { color: "red" }));
		expect(result.fixes).toEqual(["drop_key:.:color"]);
	});
});

describe("view names", () => {
	test("aliases are mapped", () => {
		const result = fixed(
			layout([
				{ view: "heading", title: "a" },
				{ view: "card", title: "b", body: "c" },
				{ view: "Text_Block", title: "d" },
			]),
		);
		expect(children(result).map((c) => c.view)).toEqual([
			"text-block",
			"info-card",
			"text-block",
		]);
		expect(result.fixes).toEqual([
			"alias:children/0:heading->text-block",
			"alias:children/1:card->info-card",
			"alias:children/2:Text_Block->text-block",
		]);
	});
	test("img becomes image", () => {
		const result = fixed(
			layout([
				block(),
				{ view: "img", image: { provider: "placeholder", alt: "a" } },
			]),
		);
		expect(children(result)[1]!.view).toBe("image");
	});
	test("a text alias moves its text into the missing title", () => {
		const result = fixed(layout([{ view: "paragraph", text: "本文です" }]));
		expect(children(result)).toEqual([
			{ view: "text-block", title: "本文です" },
		]);
		expect(result.fixes).toEqual([
			"alias:children/0:paragraph->text-block",
			"move_key:children/0:text->title",
		]);
	});
	test("content and label move too, but a present title stays", () => {
		const a = fixed(layout([{ view: "text", content: "c" }]));
		expect(children(a)[0]).toEqual({ view: "text-block", title: "c" });
		const b = fixed(layout([{ view: "text", title: "t", body: "b" }]));
		expect(children(b)[0]).toEqual({
			view: "text-block",
			title: "t",
			body: "b",
		});
	});
	test("unaliased and unknown views are dropped", () => {
		const result = fixed(
			layout([
				block(),
				{ view: "button", label: "go" },
				{ view: "list", items: [] },
				{ view: "video" },
				{ view: "iframe" },
				{ view: "settings" },
				{ foo: 1 },
				"text",
			]),
		);
		expect(children(result)).toEqual([block()]);
		expect(result.fixes).toEqual([
			"drop_part:children/1:unknown_view",
			"drop_part:children/2:unknown_view",
			"drop_part:children/3:unknown_view",
			"drop_part:children/4:unknown_view",
			"drop_part:children/5:unknown_view",
			"drop_part:children/6:no_view",
			"drop_part:children/7:not_object",
		]);
	});
});

describe("generic repairs from the schema issues", () => {
	test("a long string is cut to max - 1 characters plus an ellipsis", () => {
		const result = fixed(layout([block("あ".repeat(130))]));
		expect(children(result)[0]!.title).toBe(`${"あ".repeat(119)}…`);
		expect(result.fixes).toEqual(["truncate:children/0/title"]);
	});
	test("a cut never splits a surrogate pair", () => {
		const result = fixed(layout([block("😀".repeat(70))]));
		const title = children(result)[0]!.title as string;
		expect(title.length).toBeLessThanOrEqual(120);
		expect(title.endsWith("…")).toBe(true);
		expect(title.slice(0, -1)).toBe("😀".repeat(59));
	});
	test("a long array is cut to its maximum", () => {
		const items = Array.from({ length: 50 }, (_, i) => ({
			question: `q${i}`,
			answer: "a",
		}));
		const result = fixed(layout([{ view: "faq", items }]));
		expect((children(result)[0]!.items as unknown[]).length).toBe(48);
		expect(result.fixes).toEqual(["trim_array:children/0/items"]);
	});
	test("more than 48 children are cut", () => {
		const result = fixed(layout(Array.from({ length: 60 }, () => block())));
		expect(children(result).length).toBe(48);
		expect(result.fixes).toEqual(["trim_array:children"]);
	});
	test("an invalid optional enum is dropped", () => {
		const result = fixed(layout([{ view: "hero", title: "t", align: "left" }]));
		expect(children(result)[0]).toEqual({ view: "hero", title: "t" });
		expect(result.fixes).toEqual(["drop_optional:children/0/align"]);
	});
	test("a differently cased enum value is corrected", () => {
		const result = fixed(
			layout([{ view: "text-block", title: "t", emphasis: "Strong" }]),
		);
		expect(children(result)[0]!.emphasis).toBe("strong");
		expect(result.fixes).toEqual(["enum:children/0/emphasis"]);
	});
	test("an invalid layout direction becomes stack", () => {
		const a = fixed(layout([block()], { direction: "row" }));
		expect(a.definition.direction).toBe("stack");
		expect(a.fixes).toEqual(["enum:direction"]);
		const b = fixed(layout([block()], { direction: "form-preview" }));
		expect(b.definition.direction).toBe("stack");
	});
	test("an invalid required enum takes the first value", () => {
		const result = fixed(
			layout([
				{
					view: "chart",
					kind: "scatter",
					series: [{ name: "a", points: [{ x: 1, y: 2 }] }],
				},
			]),
		);
		expect(children(result)[0]!.kind).toBe("bar");
		expect(result.fixes).toEqual(["enum:children/0/kind"]);
	});
	test("a wrong step is rounded to the nearest valid one", () => {
		const result = fixed(
			layout([{ view: "product-card", name: "n", price: "1", rating: 3.7 }]),
		);
		expect(children(result)[0]!.rating).toBe(3.5);
		expect(result.fixes).toEqual(["round:children/0/rating"]);
	});
	test("a non-integer where an integer is needed is rounded", () => {
		const result = fixed(
			layout(
				[
					{
						view: "slider",
						bind: "a",
						label: "l",
						decimals: 1.6,
					},
				],
				{
					model: { state: { a: { type: "number", initial: 1 } } },
				},
			),
		);
		expect(children(result)[0]!.decimals).toBe(2);
	});
	test("a number over its maximum is clamped", () => {
		const result = fixed(
			layout([{ view: "product-card", name: "n", price: "1", rating: 7 }]),
		);
		expect(children(result)[0]!.rating).toBe(5);
		expect(result.fixes).toEqual(["clamp:children/0/rating"]);
	});
	test("a missing required key drops the part", () => {
		const result = fixed(layout([block(), { view: "info-card", title: "t" }]));
		expect(children(result)).toEqual([block()]);
		expect(result.fixes).toEqual(["drop_part:children/1:missing:body"]);
	});
	test("an unfixable optional value is dropped, a required one drops the part", () => {
		const a = fixed(
			layout([{ view: "hero", title: "t", eyebrow: "" }, block()]),
		);
		expect(children(a)[0]).toEqual({ view: "hero", title: "t" });
		const b = fixed(layout([{ view: "hero", title: "" }, block()]));
		expect(children(b)).toEqual([block()]);
	});
	test("a nested union is followed to its own issue", () => {
		const result = fixed(
			layout([
				{
					view: "diagram",
					elements: [
						{ type: "label", x: 1, y: 1, text: "t" },
						{ type: "label", x: 1, y: 1, text: "t", expr: "1+1" },
					],
				},
			]),
		);
		expect((children(result)[0]!.elements as Obj[])[1]).toEqual({
			type: "label",
			x: 1,
			y: 1,
			text: "t",
		});
		expect(result.fixes).toEqual(["drop_optional:children/0/elements/1/expr"]);
	});
	test("an element with an unknown type drops the whole part", () => {
		const result = fixed(
			layout([block(), { view: "diagram", elements: [{ type: "star" }] }]),
		);
		expect(children(result)).toEqual([block()]);
	});
	test("exactly-one rules: both given keeps the first", () => {
		const result = fixed(
			layout([{ view: "stat", label: "l", value: "1", expr: "1+1" }]),
		);
		expect(children(result)[0]).toEqual({
			view: "stat",
			label: "l",
			value: "1",
		});
	});
	test("a variant that needs an image loses the variant", () => {
		const result = fixed(
			layout([{ view: "hero", title: "t", variant: "split" }]),
		);
		expect(children(result)[0]).toEqual({ view: "hero", title: "t" });
		expect(result.fixes).toEqual(["drop_optional:children/0/variant"]);
	});
	test("a table with ragged rows is dropped", () => {
		const result = fixed(
			layout([
				block(),
				{
					view: "comparison-table",
					columns: ["a", "b"],
					rows: [{ label: "r", values: ["x"] }],
				},
			]),
		);
		expect(children(result)).toEqual([block()]);
	});
});

describe("images", () => {
	const hero = (image: unknown) =>
		layout([{ view: "hero", title: "t", image }]);
	test("a URL becomes a placeholder", () => {
		const result = fixed(hero("https://example.com/a.jpg"));
		expect(children(result)[0]!.image).toEqual({
			provider: "placeholder",
			tone: "neutral",
		});
		expect(result.fixes).toEqual(["image_placeholder:children/0/image"]);
	});
	test("an unknown provider keeps a valid alt", () => {
		const result = fixed(hero({ provider: "unsplash", url: "u", alt: "山" }));
		expect(children(result)[0]!.image).toEqual({
			provider: "placeholder",
			tone: "neutral",
			alt: "山",
		});
	});
	test("an unknown picsum theme or a bad seed becomes a placeholder", () => {
		const theme = fixed(hero({ provider: "picsum", theme: "moon", alt: "a" }));
		expect(children(theme)[0]!.image).toEqual({
			provider: "placeholder",
			tone: "neutral",
			alt: "a",
		});
		const seed = fixed(
			hero({ provider: "picsum", theme: "sea", seed: "Bad Seed!", alt: "a" }),
		);
		expect(seed.fixes).toEqual(["image_placeholder:children/0/image"]);
	});
	test("a too long alt is not kept", () => {
		const result = fixed(
			hero({ provider: "picsum", theme: "moon", alt: "a".repeat(500) }),
		);
		expect(children(result)[0]!.image).toEqual({
			provider: "placeholder",
			tone: "neutral",
		});
	});
	test("a valid picture is left alone, a long alt is cut", () => {
		const image = { provider: "picsum", theme: "sea", seed: "ok-1", alt: "a" };
		expect(fixed(hero(image)).fixes).toEqual([]);
		const long = fixed(hero({ ...image, alt: "a".repeat(500) }));
		expect(long.fixes).toEqual(["truncate:children/0/image/alt"]);
	});
	test("an avatar is handled the same way", () => {
		const result = fixed(
			layout([{ view: "testimonial", quote: "q", name: "n", avatar: "x.png" }]),
		);
		expect(result.fixes).toEqual(["image_placeholder:children/0/avatar"]);
	});
	test("a required picture that is missing drops the part", () => {
		const result = fixed(layout([block(), { view: "image" }]));
		expect(children(result)).toEqual([block()]);
	});
});

describe("state", () => {
	const input = (bind: string, extra: Obj = {}) => ({
		view: "number-input",
		bind,
		label: "l",
		...extra,
	});
	test("a model of a nested layout moves to the outermost layout", () => {
		const result = fixed(
			layout([
				layout([input("age")], {
					model: { state: { age: { type: "number", initial: 3 } } },
				}),
			]),
		);
		expect(result.definition.model).toEqual({
			state: { age: { type: "number", initial: 3 } },
		});
		expect(children(result)[0]!.model).toBeUndefined();
		expect(result.fixes).toEqual(["move_model:children/0/model"]);
	});
	test("nested models merge with the root's when no name collides", () => {
		const result = fixed(
			layout(
				[
					layout([block()], {
						model: { state: { b: { type: "boolean", initial: true } } },
					}),
				],
				{ model: { state: { a: { type: "text", initial: "" } } } },
			),
		);
		expect(Object.keys((result.definition.model as Obj).state as Obj)).toEqual([
			"a",
			"b",
		]);
	});
	test("a colliding nested model is dropped", () => {
		const result = fixed(
			layout(
				[
					layout([block()], {
						model: { state: { a: { type: "number", initial: 9 } } },
					}),
				],
				{ model: { state: { a: { type: "number", initial: 1 } } } },
			),
		);
		expect(result.definition.model).toEqual({
			state: { a: { type: "number", initial: 1 } },
		});
		expect(result.fixes).toEqual(["drop_model:children/0/model"]);
	});
	test("an unbound number input gets a state, using its min and max", () => {
		const result = fixed(layout([input("qty", { min: 1, max: 9 })]));
		expect(result.definition.model).toEqual({
			state: { qty: { type: "number", initial: 1, min: 1, max: 9 } },
		});
		expect(result.fixes).toEqual(["add_state:model/state/qty:number"]);
	});
	test("an unbound number input without a range starts at 0", () => {
		const result = fixed(layout([input("qty")]));
		expect((result.definition.model as Obj).state).toEqual({
			qty: { type: "number", initial: 0 },
		});
	});
	test("an unbound choice gets a text state and a toggle a boolean", () => {
		const result = fixed(
			layout([
				{ view: "choice", bind: "plan", options: ["a", "b"] },
				{ view: "toggle", bind: "pro", label: "l" },
			]),
		);
		expect((result.definition.model as Obj).state).toEqual({
			plan: { type: "text", initial: "" },
			pro: { type: "boolean", initial: false },
		});
	});
	test("a bind of the wrong type or a computed value drops the part", () => {
		const result = fixed(
			layout([block(), { view: "toggle", bind: "n", label: "l" }], {
				model: { state: { n: { type: "number", initial: 1 } } },
			}),
		);
		expect(children(result)).toEqual([block()]);
		expect(result.fixes).toEqual(["drop_part:children/1:bind_type_mismatch"]);
	});
	test("a chart over an unknown series is dropped", () => {
		const result = fixed(
			layout([
				block(),
				{ view: "chart", kind: "line", series: [{ name: "a", from: "nope" }] },
			]),
		);
		expect(children(result)).toEqual([block()]);
	});
	test("an input range reaching outside its state loses the key", () => {
		const result = fixed(
			layout([input("n", { max: 100 })], {
				model: { state: { n: { type: "number", initial: 1, max: 10 } } },
			}),
		);
		expect(children(result)[0]).toEqual(input("n"));
		expect(result.fixes).toEqual(["drop_key:children/0:max"]);
	});
	test("an invalid state is dropped and an input gets a default state instead", () => {
		const result = fixed(
			layout([input("n")], {
				model: { state: { n: { type: "number", initial: "x" } } },
			}),
		);
		expect(result.definition.model).toEqual({
			state: { n: { type: "number", initial: 0 } },
		});
		expect(result.fixes).toEqual([
			"drop_state:model/state/n",
			"add_state:model/state/n:number",
		]);
	});
	test("more than 32 states are cut", () => {
		const state = Object.fromEntries(
			Array.from({ length: 34 }, (_, i) => [
				`s${i}`,
				{ type: "boolean", initial: false },
			]),
		);
		const result = fixed(layout([block()], { model: { state } }));
		expect(
			Object.keys((result.definition.model as Obj).state as Obj).length,
		).toBe(32);
	});
});

describe("expressions", () => {
	const model = {
		state: { a: { type: "number", initial: 1 } },
		computed: { good: "a * 2", broken: "a +* 2", unknown: "nope + 1" },
	};
	test("computed entries with broken or unknown expressions are dropped", () => {
		const result = fixed(layout([block()], { model }));
		expect((result.definition.model as Obj).computed).toEqual({
			good: "a * 2",
		});
		expect(result.fixes).toEqual([
			"drop_computed:model/computed/broken",
			"drop_computed:model/computed/unknown",
		]);
	});
	test("a part using a dropped value goes with it", () => {
		const result = fixed(
			layout(
				[
					block(),
					{ view: "stat", label: "l", expr: "unknown * 2" },
					{ view: "stat", label: "l", expr: "good" },
				],
				{ model },
			),
		);
		expect(children(result).length).toBe(2);
		expect(result.fixes).toContain("drop_part:children/1:unknown_name");
	});
	test("a part with a broken expression is dropped", () => {
		const result = fixed(
			layout([block(), { view: "stat", label: "l", expr: "1 +" }]),
		);
		expect(children(result)).toEqual([block()]);
	});
	test("a computed value reading another in a circle is dropped", () => {
		const result = fixed(
			layout([block()], {
				model: { computed: { x: "y + 1", y: "x + 1" } },
			}),
		);
		expect(result.fixes.some((fix) => fix.startsWith("drop_computed:"))).toBe(
			true,
		);
	});
	test("a layout with a broken `when` keeps its children and loses the key", () => {
		const result = fixed(
			layout([block(), layout([block("b")], { when: "zzz" })]),
		);
		expect(children(result)[1]).toEqual(layout([block("b")]));
		expect(result.fixes).toEqual(["drop_key:children/1:when"]);
	});
});

describe("limits", () => {
	test("forms after the first are dropped", () => {
		const form = (id: string) => ({
			view: "form",
			title: "f",
			fields: [{ id, label: "l", type: "text" }],
		});
		const result = fixed(layout([form("a"), layout([form("b")]), block()]));
		expect(JSON.stringify(result.definition)).not.toContain('"id":"b"');
		expect(result.fixes).toEqual([
			"drop_form:children/1/children/0",
			"drop_part:children/1:empty",
		]);
	});
	test("layouts deeper than 6 give their children to the parent", () => {
		let deep: Obj = layout([block("deepest")]);
		for (let level = 0; level < 7; level += 1)
			deep = layout([deep, block(`l${level}`)]);
		const result = fixed(deep);
		expect(JSON.stringify(result.definition)).toContain("deepest");
		expect(result.fixes.some((fix) => fix.startsWith("lift_children:"))).toBe(
			true,
		);
	});
	test("a depth-6 chain of layouts is valid and left alone", () => {
		const leaf = layout([block()]);
		const definition = layout([layout([layout([layout([leaf])])])]);
		// root(1) > 2 > 3 > 4 > 5 (leaf layout) > text-block at 6
		expect(fixDefinition(definition)).toEqual({
			ok: true,
			definition,
			fixes: [],
		});
	});
	test("parts over 240 are dropped from the end", () => {
		const parts = Array.from({ length: 300 }, (_, i) => block(`p${i}`));
		const groups = Array.from({ length: 10 }, (_, i) =>
			layout(parts.slice(i * 30, i * 30 + 30)),
		);
		const result = fixed(layout(groups));
		const text = JSON.stringify(result.definition);
		expect(text).toContain('"p0"');
		expect(text).not.toContain('"p299"');
		expect(result.fixes.at(-1)).toMatch(/^drop_parts:over_parts:\d+$/);
	});
	test("over 96 KiB drops parts from the end", () => {
		const big = (i: number) => ({
			view: "text-block",
			title: `p${i}`,
			body: "あ".repeat(1900),
		});
		const result = fixed(layout(Array.from({ length: 40 }, (_, i) => big(i))));
		expect(JSON.stringify(result.definition)).toContain('"p0"');
		expect(JSON.stringify(result.definition)).not.toContain('"p39"');
		expect(
			result.fixes.some((fix) => fix.startsWith("drop_parts:over_bytes:")),
		).toBe(true);
	});
});

describe("nothing displayable", () => {
	const failed = (input: unknown) => {
		const result = fixDefinition(input);
		expect(result.ok).toBe(false);
		return result as Extract<FixResult, { ok: false }>;
	};
	test("non-objects", () => {
		for (const input of [null, undefined, "text", 5, true, []]) failed(input);
	});
	test("an empty layout", () => {
		failed(layout([]));
		failed({ view: "layout" });
	});
	test("every part dropped", () => {
		const result = failed(layout([{ view: "button" }, { view: "video" }]));
		expect(result.fixes).toContain("drop_part:children/0:unknown_view");
	});
	test("only empty layouts remain", () => {
		failed(layout([layout([{ view: "button" }])]));
	});
	test("a single unknown part", () => {
		failed({ view: "button" });
	});
});

describe("determinism and robustness", () => {
	const messy = () =>
		layout(
			[
				{ view: "heading", text: "h".repeat(200), source: "x" },
				{ view: "img", image: "http://x/y.png" },
				{ view: "number-input", bind: "q", label: "l" },
				{ view: "hero", title: "t", align: "x", variant: "split" },
				{ view: "mystery" },
			],
			{ tabs: [], direction: "wide" },
		);
	test("the same input gives the same output", () => {
		const first = fixDefinition(messy());
		const second = fixDefinition(messy());
		expect(second).toEqual(first);
		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
	});
	test("a messy definition ends valid", () => {
		const result = fixDefinition(messy());
		expect(result.ok).toBe(true);
	});
	test("fixing the output again changes nothing", () => {
		const first = fixed(messy());
		expect(fixDefinition(first.definition)).toEqual({
			ok: true,
			definition: first.definition,
			fixes: [],
		});
	});
	test("the input is not mutated", () => {
		const input = messy();
		const snapshot = structuredClone(input);
		fixDefinition(input);
		expect(input).toEqual(snapshot);
	});
});
