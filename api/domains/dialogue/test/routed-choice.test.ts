import { expect, test } from "bun:test";
import {
	fillMessages,
	fillSchema,
	parseChoice,
	strictChoiceSchema,
	type ChoiceCandidate,
} from "../service/routed-choice";
import { namedResources, namedTodos } from "../service/state-text";

/**
 * The one-candidate fill of the toolchain the router decided (spec router-package-integration 2026-11-04 §1 #14): a
 * hand-over refers only to the resources `## State` names (the schema offers those `a<n>` and no other text, and a
 * turn that names none has no `refs` to fill), names its target, and reaches a cloud provider in strict form.
 */
const MUSIC: ChoiceCandidate = {
	id: "music",
	title: "曲を作る",
	execution: "task",
};
const refsOf = (schema: Record<string, unknown>) =>
	(
		schema.anyOf as Array<{
			properties: {
				choice: { enum: string[] };
				refs?: Record<string, unknown>;
			};
		}>
	).find((branch) => branch.properties.choice.enum[0] === MUSIC.id)!.properties
		.refs;

test("the resources State names are its references, not the words of their labels", () => {
	expect(
		namedResources([
			"今: 10-30（木）14:00",
			"仕事:",
			"- t1 朝の曲 通知済み a3「朝の曲 a9」",
			"提示中:",
			"- a4 画像「data1の図」（画面に表示中）",
			"- a3（直前の返事で示した）",
		]),
	).toEqual(["a3", "a4"]);
});

test("a hand-over's refs are the named resources; with none named the branch has no refs", () => {
	expect(
		refsOf(fillSchema(MUSIC, { resources: ["a3", "a4"], switching: null })),
	).toEqual({
		type: "array",
		maxItems: 8,
		items: { type: "string", enum: ["a3", "a4"] },
	});
	expect(
		refsOf(fillSchema(MUSIC, { resources: [], switching: null })),
	).toBeUndefined();
});

test("the work State lists is read by its lines' heads: a title that holds a number is not work", () => {
	expect(
		namedTodos([
			"## State",
			"仕事:",
			"- t1 t5の見直し 実行中",
			"- t3 朝の曲 通知済み a3「朝の曲 t9」",
			"- c2 確認待ち fake.image「t7」",
		]),
	).toEqual([1, 3]);
});

test("a toolchain with saved items always names its target: new first, then the items; the system says when each", () => {
	const studio: ChoiceCandidate = {
		id: "ui.compose",
		title: "UI自由制作",
		execution: "session",
		targets: [{ ref: "item-1", label: "保存済み1" }],
	};
	const [system] = fillMessages({
		style: "丁寧",
		routed: {
			memory: null,
			earlier: [],
			state: "## State\n今: 10-31（金）00:21",
			previousReply: null,
			asked: null,
			pending: { confirmations: [], questions: [] },
			todos: [],
			resources: [],
			switching: null,
		},
		candidate: studio,
		utterance: "イヤホンのランディングページを作ってみて",
	});
	expect(system!.content).toContain(
		"target は、新しく作る依頼なら new を選びます。今の発言が保存済みの作品を直す・続けると言っているときだけ、その作品を選びます。",
	);
	const branch = (
		fillSchema(studio, { resources: [], switching: null }).anyOf as Array<{
			required: string[];
			properties: Record<string, { enum?: string[] }>;
		}>
	).find((b) => b.properties.choice?.enum?.[0] === "ui.compose")!;
	expect(branch.required).toContain("target");
	expect(branch.properties.target!.enum).toEqual(["new", "item-1"]);
});

/** Where a schema breaks a cloud provider's strict structured output: the paths of the broken points. */
function strictBreaks(schema: Record<string, unknown>, path = "$"): string[] {
	const breaks: string[] = [];
	for (const key of ["minLength", "maxLength", "maxItems", "minItems"])
		if (key in schema) breaks.push(`${path}.${key}`);
	if (Array.isArray(schema.anyOf))
		(schema.anyOf as Array<Record<string, unknown>>).forEach((s, i) =>
			breaks.push(...strictBreaks(s, `${path}.anyOf[${i}]`)),
		);
	const types = [schema.type].flat();
	if (types.includes("object")) {
		const properties = (schema.properties ?? {}) as Record<
			string,
			Record<string, unknown>
		>;
		if (schema.additionalProperties !== false)
			breaks.push(`${path}.additionalProperties`);
		if (
			JSON.stringify([...((schema.required as string[]) ?? [])].sort()) !==
			JSON.stringify(Object.keys(properties).sort())
		)
			breaks.push(`${path}.required`);
		for (const [key, field] of Object.entries(properties))
			breaks.push(...strictBreaks(field, `${path}.${key}`));
	}
	if (types.includes("array") && schema.items)
		breaks.push(
			...strictBreaks(schema.items as Record<string, unknown>, `${path}[]`),
		);
	return breaks;
}

test("a cloud provider gets the fill in strict form: one object, every field required and nullable, no ranges; the host reads it back", () => {
	const weather: ChoiceCandidate = {
		id: "weather",
		title: "天気",
		execution: "instant",
		inputs: {
			type: "object",
			properties: { place: { type: "string", minLength: 1 } },
			required: ["place"],
		},
	};
	const strict = strictChoiceSchema(
		fillSchema(weather, { resources: ["a2"], switching: "studio" }),
	);
	expect(strict.anyOf).toBeUndefined();
	expect(strictBreaks(strict)).toEqual([]);
	const properties = strict.properties as Record<
		string,
		Record<string, unknown>
	>;
	expect(properties.choice).toEqual({
		type: "string",
		enum: ["none", "ask", "weather"],
	});
	// A toolchain's inputs keep their named fields, so the provider holds the answer to them (a bare value in their
	// place is not a valid answer); the bounds stay the toolchain's own check.
	expect(properties.inputs).toEqual({
		anyOf: [
			{
				type: "object",
				additionalProperties: false,
				required: ["place"],
				properties: { place: { type: "string" } },
			},
			{ type: "null" },
		],
	});
	expect(
		strictBreaks(
			strictChoiceSchema(
				fillSchema("memory.request", { resources: [], switching: null }),
			),
		),
	).toEqual([]);
	// The answer fills every field: the nulls are dropped and the inputs read back into their object.
	expect(
		parseChoice(
			JSON.stringify({
				choice: "weather",
				inputs: JSON.stringify({ place: "鎌倉" }),
				say: null,
				request: null,
				target: null,
			}),
		),
	).toEqual({ choice: "weather", inputs: { place: "鎌倉" } });
});

test("strict inputs: a field the answer may leave out is required and nullable, and its null is dropped; inputs with no named field go as JSON text", () => {
	const history: ChoiceCandidate = {
		id: "read_history",
		title: "会話の記録",
		execution: "read",
		inputs: {
			type: "object",
			properties: {
				query: { type: "string", minLength: 1, description: "探す語" },
				speaker: { type: "string", enum: ["user", "assistant"] },
				count: { type: "integer", minimum: 1, maximum: 5 },
				names: {
					type: "array",
					minItems: 1,
					items: { type: "string", maxLength: 60 },
				},
			},
			required: ["names"],
			additionalProperties: false,
		},
	};
	const strict = strictChoiceSchema(
		fillSchema(history, { resources: [], switching: null }),
	);
	expect(strictBreaks(strict)).toEqual([]);
	const inputs = (
		strict.properties as Record<
			string,
			{ anyOf: Array<Record<string, unknown>> }
		>
	).inputs!.anyOf[0]!;
	expect(inputs.required).toEqual(["query", "speaker", "count", "names"]);
	expect(inputs.properties).toEqual({
		query: { type: ["string", "null"], description: "探す語" },
		speaker: { type: ["string", "null"], enum: ["user", "assistant", null] },
		count: { type: ["integer", "null"] },
		names: { type: "array", items: { type: "string" } },
	});
	expect(
		parseChoice(
			JSON.stringify({
				choice: "read_history",
				inputs: { query: null, speaker: "user", count: null, names: ["旅行"] },
			}),
		),
	).toEqual({
		choice: "read_history",
		inputs: { speaker: "user", names: ["旅行"] },
	});
	// Inputs that name no field (any object) can not be held strictly: they stay the JSON text of their object.
	const open: ChoiceCandidate = {
		id: "open",
		title: "自由な欄",
		execution: "instant",
	};
	const text = (
		strictChoiceSchema(fillSchema(open, { resources: [], switching: null }))
			.properties as Record<string, Record<string, unknown>>
	).inputs!;
	expect(text.type).toEqual(["string", "null"]);
});
