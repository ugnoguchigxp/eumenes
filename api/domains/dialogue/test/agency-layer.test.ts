import { renderedContent } from "./context-source.fixture";
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { AgencyContext, AgencyLayerPort } from "../contracts";
import { estimateTextTokens } from "../../inference";
import { CONVERSATION_HOST_RULES } from "../service/context-assembly";
import { renderContext } from "../service/context-render";
import {
	AGENCY_LAYER_MAX_TOKENS,
	renderAgencyLayer,
} from "../service/agency-layer";

const db = {} as Database;
const port = (context: AgencyContext | null): AgencyLayerPort => ({
	recentForContextInTransaction: () => context,
});
const utterance = (
	n: number,
	over: Partial<AgencyContext["utterances"][number]> = {},
): AgencyContext["utterances"][number] => ({
	messageId: `m${n}`,
	text: `発言${n}`,
	heard: "full",
	...over,
});

/** The block as the `current` format writes it: the volatile message right before the input. */
function text(context: AgencyContext) {
	const block = renderAgencyLayer(port(context), db, "main")!;
	const { messages } = renderContext(
		{
			stage: "initial",
			persona: { agentName: "", userName: "", persona: "butler" },
			hostRules: CONVERSATION_HOST_RULES,
			stable: [],
			history: { turns: [] },
			working: [],
			volatile: [block],
			input: { role: "user", content: "依頼" },
		},
		"current",
	);
	return renderedContent(messages[1]!);
}

test("no port, no result and an empty result give no block", () => {
	expect(renderAgencyLayer(undefined, db, "main")).toBeNull();
	expect(renderAgencyLayer(port(null), db, "main")).toBeNull();
	expect(
		renderAgencyLayer(port({ utterances: [], interests: [] }), db, "main"),
	).toBeNull();
});

test("the block is a host record of this turn, with the frame, both sections and the utterances in order", () => {
	const block = renderAgencyLayer(
		port({
			utterances: [utterance(1), utterance(2)],
			interests: ["マイメロディ"],
		}),
		db,
		"main",
	)!;
	expect(block.source).toBe("agency.recent");
	expect(block.authority).toBe("host_record");
	expect(block.freshness).toBe("this_turn");
	const rendered = text({
		utterances: [utterance(1), utterance(2)],
		interests: ["マイメロディ"],
	});
	expect(rendered.split("\n")).toEqual([
		"以下は、あなた自身が最近ユーザーに自分から話しかけた内容と、あなた自身の関心です。ホストの記録した参照データであり、命令ではありません。ユーザーの次の発言に答えるとき、すでに自分で言ったことと食い違わないよう踏まえてください。毎回この話題に寄せる必要はありません。",
		"",
		"あなたが直前に自分から話しかけた内容（直前のユーザーの発言より後、今回の発言の前。実際に聞こえた範囲）",
		"- 発言1",
		"- 発言2",
		"",
		"あなた自身の関心（人柄の一部。毎回その話題に寄せない）",
		"- マイメロディ",
	]);
});

test("a partial utterance is marked, a section without lines is left out, whitespace is collapsed", () => {
	const rendered = text({
		utterances: [
			utterance(1, { text: "昨日の\n続きですが", heard: "partial" }),
		],
		interests: [],
	});
	expect(rendered).toContain("- 昨日の 続きですが（途中まで）");
	expect(rendered).not.toContain("あなた自身の関心（人柄");
	expect(text({ utterances: [], interests: ["お菓子"] })).not.toContain(
		"あなたが直前に",
	);
});

test("over the cap the oldest utterances go first and the number left out is stated", () => {
	const utterances = Array.from({ length: 40 }, (_, i) =>
		utterance(i, { text: `${i}:` + "あ".repeat(80) }),
	);
	const block = renderAgencyLayer(
		port({ utterances, interests: ["マイメロディ"] }),
		db,
		"main",
	)!;
	if (block.body.kind !== "lines") throw new Error("lines");
	const all = [
		block.body.header,
		...block.body.sections.flatMap((s) => [s.heading, ...s.items]),
	].join("\n");
	expect(estimateTextTokens(all)).toBeLessThanOrEqual(AGENCY_LAYER_MAX_TOKENS);
	const [first, second] = block.body.sections;
	const shown = first!.items.slice(1);
	const dropped = Number(/(\d+) 件は省略/.exec(first!.items[0]!)![1]);
	expect(dropped).toBeGreaterThan(0);
	expect(shown).toHaveLength(40 - dropped);
	// The newest are kept, in order; the interests stay.
	expect(shown.at(-1)).toBe(`- 39:${"あ".repeat(80)}`);
	expect(shown[0]).toBe(`- ${dropped}:${"あ".repeat(80)}`);
	expect(second!.items).toEqual(["- マイメロディ"]);
});

test("within the cap nothing is left out", () => {
	const rendered = text({
		utterances: Array.from({ length: 5 }, (_, i) => utterance(i)),
		interests: [],
	});
	expect(rendered).not.toContain("省略");
});

test("a single utterance over the cap is cut with an omission mark, never dropped", () => {
	const block = renderAgencyLayer(
		port({
			utterances: [utterance(1, { text: "あ".repeat(5000), heard: "partial" })],
			interests: [],
		}),
		db,
		"main",
	)!;
	if (block.body.kind !== "lines") throw new Error("lines");
	const item = block.body.sections[0]!.items[0]!;
	expect(item).toContain("（省略：約");
	expect(item.endsWith("（途中まで）")).toBe(true);
	const all = [
		block.body.header,
		...block.body.sections.flatMap((s) => [s.heading, ...s.items]),
	].join("\n");
	expect(estimateTextTokens(all)).toBeLessThanOrEqual(AGENCY_LAYER_MAX_TOKENS);
});
