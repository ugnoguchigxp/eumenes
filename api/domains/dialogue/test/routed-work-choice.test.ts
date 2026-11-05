import { expect, test } from "bun:test";
import { chooseWholeWork } from "../service/routed-work-choice";
import type { RouteCandidate } from "../service/routed-route";
import type { Turn } from "../service/routed-turn";

type Toolchain = Extract<RouteCandidate, { kind: "toolchain" }>;
const candidate = (id: string, execution: string): Toolchain =>
	({
		id,
		kind: "toolchain",
		card: { id, execution },
		choice: { id, title: id, execution },
	}) as Toolchain;
const planner = candidate("fake.planner", "pipeline");
const editor = candidate("fake.editor", "session");
const image = candidate("fake.image", "task");
function turn(answer: unknown) {
	const calls: Array<{ messages: unknown; schema: unknown }> = [];
	const said: string[] = [];
	return {
		calls,
		said,
		value: {
			exchange: [],
			utterance: "相談したい",
			deps: {
				store: { read: (fn: (db: unknown) => unknown) => fn({}) },
				larm: {},
			},
			routed: {
				resources: [],
				switching: null,
				earlier: [],
				state: "現在の作業なし",
			},
			choose: async (messages: unknown, schema: unknown) => {
				calls.push({ messages, schema });
				return answer;
			},
			speak: (text: string) => said.push(text),
		} as unknown as Turn,
	};
}

test("multiple candidates may describe one interactive work: offer whole-work owners, not a partial first job", async () => {
	const h = turn({
		choice: editor.id,
		request: "章と登場人物を一緒に推敲する",
		target: "new",
	});
	const selected = await chooseWholeWork(
		h.value,
		"章と登場人物を一緒に推敲する",
		planner,
		[planner, editor, image],
	);
	expect(selected).toEqual({
		candidate: editor,
		fields: {
			choice: editor.id,
			request: "章と登場人物を一緒に推敲する",
			target: "new",
		},
	});
	expect(h.calls).toHaveLength(1);
	const schema = JSON.stringify(h.calls[0]!.schema);
	expect(schema).toContain(planner.id);
	expect(schema).toContain(editor.id);
	expect(schema).not.toContain(image.id);
	expect(JSON.stringify(h.calls[0]!.messages)).toContain(
		"章と登場人物を一緒に推敲する",
	);
});

test("a genuine execution keeps the entire original request even if the model writes a first-job summary", async () => {
	const h = turn({ choice: planner.id, request: "画像を作る" });
	const words = "資料を読み、画像と音楽を作って結果をまとめて";
	expect(
		await chooseWholeWork(h.value, words, planner, [planner, editor]),
	).toEqual({ candidate: planner, fields: { request: words } });
});

test("no interactive owner leaves the existing multi-job path intact without an extra model call", async () => {
	const h = turn(null);
	expect(
		await chooseWholeWork(h.value, "二つの仕事を実行して", planner, [
			planner,
			image,
		]),
	).toEqual({ candidate: planner });
	expect(h.calls).toHaveLength(0);
});

test("an unavailable or partial candidate never becomes a handover; none and malformed choices also fall back", async () => {
	for (const answer of [
		null,
		"cut",
		{ choice: "none" },
		{ choice: image.id },
		{ choice: "unavailable" },
	]) {
		const h = turn(answer);
		expect(
			await chooseWholeWork(h.value, "相談したい", planner, [
				planner,
				editor,
				image,
			]),
		).toEqual({ step: "talk" });
		expect(h.said).toEqual([]);
	}
});

test("an unresolved whole-work choice asks once without starting any owner", async () => {
	const h = turn({ choice: "ask", say: "まず案を作りますか？" });
	expect(
		await chooseWholeWork(h.value, "進めて", planner, [planner, editor]),
	).toEqual({ step: "done" });
	expect(h.said).toEqual(["まず案を作りますか？"]);
});
