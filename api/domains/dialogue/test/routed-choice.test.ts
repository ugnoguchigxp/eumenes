import { expect, test } from "bun:test";
import {
	choiceMessages,
	choiceSchema,
	type ChoiceCandidate,
} from "../service/routed-choice";
import { namedResources } from "../service/state-text";

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
