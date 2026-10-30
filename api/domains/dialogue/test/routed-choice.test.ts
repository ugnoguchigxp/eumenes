import { expect, test } from "bun:test";
import {
	choiceMessages,
	choiceSchema,
	type ChoiceCandidate,
} from "../service/routed-choice";
import { namedResources, namedTodos } from "../service/state-text";

/**
 * A hand-over refers only to the resources `## State` names (the local harness rebuild plan, section 4.3): the schema
 * offers those `a<n>` and no other text, and a turn that names none has no `refs` to fill.
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
		refsOf(choiceSchema([MUSIC], { todos: [], resources: ["a3", "a4"] })),
	).toEqual({
		type: "array",
		maxItems: 8,
		items: { type: "string", enum: ["a3", "a4"] },
	});
	expect(
		refsOf(choiceSchema([MUSIC], { todos: [], resources: [] })),
	).toBeUndefined();
});

test("a general toolchain is marked so in its line, and the choice's rules put a dedicated one and a whole pipeline first", () => {
	const [system, input] = choiceMessages({
		style: "丁寧",
		routed: {
			memory: null,
			earlier: [],
			state: "## State\n今: 10-30（木）14:00",
			previousReply: null,
			asked: null,
			pending: { confirmations: [], questions: [] },
			todos: [],
			resources: [],
		},
		candidates: [
			MUSIC,
			{ id: "web", title: "Web検索", summary: "Webで調べる", general: true },
		],
		utterance: "曲を作って",
	});
	expect(input!.content).toContain("- web: Web検索。汎用の担当。Webで調べる");
	expect(input!.content).not.toContain("- music: 曲を作る。汎用の担当");
	expect(system!.content).toContain(
		"「汎用の担当」とある担当は、ほかに依頼に合う担当がないときだけ選びます。",
	);
	expect(system!.content).toContain(
		"依頼の全体をこなせるパイプライン（execution が pipeline の担当）があれば",
	);
});

test("the choice system leaves creation details to the toolchain and asks only when the toolchain or target cannot be determined", () => {
	const [system] = choiceMessages({
		style: "丁寧",
		routed: {
			memory: null,
			earlier: [],
			state: "## State\n今: 10-30（木）14:00",
			previousReply: null,
			asked: null,
			pending: { confirmations: [], questions: [] },
			todos: [],
			resources: [],
		},
		candidates: [MUSIC],
		utterance: "曲を作って",
	});
	expect(system!.role).toBe("system");
	expect(system!.content).toContain(
		"作る中身の細部は担当が決めます。細部が決まっていなくても担当に頼みます。",
	);
	expect(system!.content).toContain(
		"頼む担当か対象が決まらないときだけ ask を選び、say に短い質問を一つ書きます。",
	);
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

test("every work may be checked; only open work may be corrected or cancelled, and its line says which", () => {
	const todos = [
		{ ref: 1, title: "調査", open: true },
		{ ref: 3, title: "朝の曲", open: false },
	];
	const branches = (
		choiceSchema([], { todos, resources: [] }).anyOf as Array<{
			properties: {
				choice: { enum: string[] };
				operation?: { enum: string[] };
			};
		}>
	).filter((branch) => branch.properties.operation);
	expect(
		branches.map((branch) => [
			branch.properties.choice.enum,
			branch.properties.operation!.enum,
		]),
	).toEqual([
		[["t1", "t3"], ["check"]],
		[["t1"], ["amend", "cancel"]],
	]);
	const [system, input] = choiceMessages({
		style: "丁寧",
		routed: {
			memory: null,
			earlier: [],
			state: "## State\n今: 10-30（木）14:00",
			previousReply: null,
			asked: null,
			pending: { confirmations: [], questions: [] },
			todos,
			resources: [],
		},
		candidates: [],
		utterance: "さっきの曲はどうなった？",
	});
	expect(input!.content).toContain(
		"- t1: 「調査」の仕事の確認（check）、訂正（amend。text に直す内容を書く）か取り消し（cancel）。",
	);
	expect(input!.content).toContain(
		"- t3: 「朝の曲」の仕事の確認（check）。終わった仕事なので、確認だけ。",
	);
	expect(system!.content).toContain(
		"その仕事を check で選びます。進行中の仕事の訂正・取り消しを頼まれたら、その仕事を amend か cancel で選びます。終わった仕事は check だけです。",
	);
});

test("a toolchain with saved items always names its target: new first, then the items; the system says when each", () => {
	const [system] = choiceMessages({
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
		},
		candidates: [MUSIC],
		utterance: "イヤホンのランディングページを作ってみて",
	});
	expect(system!.content).toContain(
		"target は、新しく作る依頼なら new を選びます。今の発言が保存済みの作品を直す・続けると言っているときだけ、その作品を選びます。",
	);
	const studio = (
		choiceSchema(
			[
				{
					id: "ui.compose",
					title: "UI自由制作",
					execution: "session",
					targets: [{ ref: "item-1", label: "保存済み1" }],
				},
			],
			{ todos: [], resources: [] },
		).anyOf as Array<{
			required: string[];
			properties: Record<string, { enum?: string[] }>;
		}>
	).find((branch) => branch.properties.choice?.enum?.[0] === "ui.compose")!;
	expect(studio.required).toContain("target");
	expect(studio.properties.target!.enum).toEqual(["new", "item-1"]);
});
