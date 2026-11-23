import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { MemoryRecalled, MemoryRecallInput } from "../../memory";
import type { PlanItem } from "../../continuity";
import type { DialogueDeps } from "../service/context";
import { reply, setup, type Harness } from "./generation.fixture";
import { saveItem } from "./memory-seed";
import {
	RECALL_MIN_SCORE,
	recallLinesInTransaction,
} from "../service/recall-text";

/**
 * `## Recall` (the implementation spec section 2.5), drawn on a made-up memory that answers as the contract says:
 * what the lines are, which are left out, and what is handed a reference.
 */
const recalled = (
	id: string,
	more: Partial<MemoryRecalled> = {},
): MemoryRecalled => ({
	id,
	revision: 1,
	kind: "personal_fact",
	text: `記録 ${id}`,
	source: "user_said",
	score: 1,
	direct: true,
	...more,
});
const plan = (id: string, more: Partial<PlanItem> = {}): PlanItem => ({
	id,
	conversationId: "main",
	kind: "plan",
	text: `予定 ${id}`,
	dueAt: null,
	state: "open",
	revision: 1,
	createdAt: "2026-11-20T10:00:00.000Z",
	lastTouchedAt: "2026-11-20T10:00:00.000Z",
	evidence: [],
	memoryItemIds: [],
	...more,
});

function fakes(options: {
	items?: MemoryRecalled[];
	found?: PlanItem[];
	open?: PlanItem[];
	terms?: string[] | "unreadable";
}) {
	const asked: MemoryRecallInput[] = [];
	const searched: string[] = [];
	const deps = {
		memory: {
			suppressionsInTransaction: () => {
				if (options.terms === "unreadable") throw new Error("unreadable");
				return { terms: options.terms ?? [] };
			},
			recallInTransaction: (_tx: unknown, input: MemoryRecallInput) => {
				asked.push(input);
				const items = options.items ?? [];
				return { total: items.length, matched: items.length, items };
			},
		},
		continuity: {
			plans: {
				searchInTransaction: (_tx: unknown, text: string) => {
					searched.push(text);
					return options.found ?? [];
				},
				listInTransaction: () => options.open ?? [],
			},
		},
	} as unknown as DialogueDeps;
	const handed: Array<{ itemId: string; revision: number }[]> = [];
	const run = (
		input: Partial<Parameters<typeof recallLinesInTransaction>[2]> = {},
	) =>
		recallLinesInTransaction(deps, {} as Database, {
			conversationId: "main",
			utterances: ["猫の名前は何だっけ"],
			shownMemoryIds: new Set(),
			shownPlanIds: new Set(),
			budget: { recallTokens: 400, recallItems: 8 },
			refOf: (items) => {
				handed.push([...items]);
				return new Map(items.map((item, n) => [item.itemId, `m${n + 10}`]));
			},
			...input,
		});
	return { run, asked, searched, handed };
}

test("the memory is asked for the user's words by what the host decides, and the lines read memory, before, plan and discord in that order", () => {
	const t = fakes({
		items: [
			recalled("a", { text: "猫の名前はミル", since: "2026-11-01" }),
			recalled("b", {
				text: "猫の名前はタマ",
				previous: [{ text: "猫の名前はクロ", until: "2026-11-10" }],
			}),
			recalled("c", {
				kind: "tendency",
				id: "tendency:7",
				text: "猫の話が多い",
				source: "observed",
			}),
		],
		found: [plan("p1", { text: "猫の病院", dueAt: "2026-11-25" })],
		open: [
			plan("q1", {
				kind: "open_question",
				text: "猫の名前はミルかタマか",
				memoryItemIds: ["a"],
			}),
		],
	});
	const found = t.run({ shownMemoryIds: new Set(["b"]) });
	expect(t.asked).toEqual([
		{
			text: "猫の名前は何だっけ",
			limit: 8,
			shown: new Set(["b"]),
			omitShown: false,
			withPrevious: true,
			minScore: RECALL_MIN_SCORE,
			audience: "host",
		},
	]);
	expect(t.searched).toEqual(["猫の名前は何だっけ"]);
	expect(found.lines).toEqual([
		// Not `b`: `## Memory` shows it already. A tendency is an estimate with no reference.
		"- 記憶: m10 猫の名前はミル（本人の発言、11-01から）",
		"- 記憶: 猫の話が多い（推定）",
		// The old value of a record shown in `## Memory` is told all the same.
		"- 以前: m11 猫の名前はクロ（2026-11-10 まで）",
		"- 予定: 猫の病院（2026-11-25）",
		"- 食い違い: m10 猫の名前はミルかタマか",
	]);
	expect(found.memoryItemIds).toEqual(["a", "b"]);
	expect(found.planIds).toEqual(["p1", "q1"]);
	// The references are handed out once, for the records the lines name, at their version.
	expect(t.handed).toEqual([
		[
			{ itemId: "a", revision: 1 },
			{ itemId: "b", revision: 1 },
		],
	]);
});

test("a plan `## State` shows already is not told again, and a plan of another kind or an unrelated question is not a line", () => {
	const t = fakes({
		items: [recalled("a")],
		found: [
			plan("shown"),
			plan("decided", { kind: "decision" }),
			plan("new", { text: "新しい予定", state: "awaiting_confirmation" }),
		],
		open: [
			plan("q-other", {
				kind: "open_question",
				text: "別の問い",
				memoryItemIds: ["zzz"],
			}),
		],
	});
	const found = t.run({ shownPlanIds: new Set(["shown"]) });
	expect(found.lines).toEqual([
		"- 記憶: m10 記録 a（本人の発言）",
		"- 予定: 新しい予定（確認待ち）",
	]);
	expect(found.planIds).toEqual(["new"]);
});

test("a line that names a topic the user asked not to be brought up is not drawn", () => {
	const t = fakes({
		items: [
			recalled("a", { text: "猫の名前はミル" }),
			recalled("b", {
				text: "犬の名前はポチ",
				previous: [{ text: "犬の名前はハチ", until: "2026-11-10" }],
			}),
		],
		found: [plan("p1", { text: "猫の病院" })],
		open: [
			plan("q1", {
				kind: "open_question",
				text: "猫の問い",
				memoryItemIds: ["b"],
			}),
		],
		terms: ["猫"],
	});
	const found = t.run();
	expect(found.lines).toEqual([
		"- 記憶: m10 犬の名前はポチ（本人の発言）",
		"- 以前: m10 犬の名前はハチ（2026-11-10 まで）",
	]);
	expect(found.planIds).toEqual([]);
});

test("nothing is drawn when the words are empty, the suppressions cannot be read or nothing relates", () => {
	const empty = fakes({ items: [recalled("a")] });
	expect(empty.run({ utterances: ["", "  "] }).lines).toEqual([]);
	expect(empty.asked).toEqual([]);
	const unreadable = fakes({ items: [recalled("a")], terms: "unreadable" });
	expect(unreadable.run()).toEqual({
		lines: [],
		memoryItemIds: [],
		planIds: [],
	});
	expect(unreadable.asked).toEqual([]);
	const none = fakes({});
	expect(none.run()).toEqual({ lines: [], memoryItemIds: [], planIds: [] });
	// Every record shown in `## Memory` and nothing else to say: no line, no reference handed out.
	const shown = fakes({ items: [recalled("a")] });
	expect(shown.run({ shownMemoryIds: new Set(["a"]) }).lines).toEqual([]);
	expect(shown.handed).toEqual([]);
});

test("the lines that fit the token bound are kept in order, and only they are handed a reference", () => {
	const items = Array.from({ length: 6 }, (_, i) =>
		recalled(`r${i}`, { text: `記録の本文その${i}を少し長めに書いたもの` }),
	);
	const t = fakes({ items });
	const all = t.run({ budget: { recallTokens: 2000, recallItems: 8 } });
	expect(all.lines.length).toBe(6);
	const small = fakes({ items });
	const some = small.run({ budget: { recallTokens: 60, recallItems: 8 } });
	expect(some.lines.length).toBeGreaterThan(0);
	expect(some.lines.length).toBeLessThan(6);
	expect(some.lines).toEqual(all.lines.slice(0, some.lines.length));
	expect(small.handed[0]!.map((item) => item.itemId)).toEqual(
		items.slice(0, some.lines.length).map((item) => item.id),
	);
	expect(some.memoryItemIds).toEqual(
		items.slice(0, some.lines.length).map((item) => item.id),
	);
	// The number of references decides nothing: the same lines are kept whatever numbers the memory handed out.
	const wide = fakes({ items });
	expect(
		wide.run({
			budget: { recallTokens: 60, recallItems: 8 },
			refOf: (given) => new Map(given.map((item) => [item.itemId, "m99999"])),
		}).lines.length,
	).toBe(some.lines.length);
});

test("a count above what the memory takes is brought down to it, and none asks for nothing", () => {
	const high = fakes({ items: [recalled("a")] });
	high.run({ budget: { recallTokens: 400, recallItems: 99 } });
	expect(high.asked[0]!.limit).toBe(21);
	const none = fakes({ items: [recalled("a")], found: [plan("p1")] });
	expect(none.run({ budget: { recallTokens: 400, recallItems: 0 } })).toEqual({
		lines: [],
		memoryItemIds: [],
		planIds: [],
	});
	expect(none.asked).toEqual([]);
});

let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

/** The turn's last message of the newest talk call. */
const lastMessage = (harness: Harness) =>
	harness.state.calls.at(-1)!.messages.at(-1)!.content;

test("the turn's last message carries `## Recall` between `## State` and `## User` only while the memory's setting turns it on, and no history keeps it", async () => {
	h = await setup({ memory: true });
	const setting = {
		alwaysTokens: 300,
		alwaysScope: "responses",
		recallEnabled: false,
		recallTokens: 300,
		recallItems: 8,
	};
	const asked: MemoryRecallInput[] = [];
	let record: MemoryRecalled | null = null;
	// The memory's own recall is being built beside this host: it answers as its contract says.
	Object.assign(h.memory!, {
		inputBudgetInTransaction: () => setting,
		recallInTransaction: (_tx: unknown, input: MemoryRecallInput) => {
			asked.push(input);
			const items = record ? [record] : [];
			return { total: items.length, matched: items.length, items };
		},
	});
	h.state.steps.push(...reply("はい。"));
	const first = await h.say("好きな色は藍色です");
	const saved = await saveItem(h.store, h.memory!, {
		conversationId: "main",
		messageId: first.inputMessageId,
		quote: "好きな色は藍色",
		kind: "preference",
		semanticKey: "color.favorite",
		text: "好きな色は藍色",
	});
	record = recalled(saved.id, {
		revision: saved.revision,
		kind: "preference",
		text: saved.text,
	});
	// Off (the default): the section is not drawn, and the memory is not asked.
	h.state.steps.push(...reply("はい。"));
	await h.say("好きな色は何だっけ");
	expect(lastMessage(h)).not.toContain("## Recall");
	expect(asked).toEqual([]);
	setting.recallEnabled = true;
	h.state.steps.push(...reply("藍色です。"));
	const second = await h.say("好きな色は何だっけ");
	const message = lastMessage(h);
	expect(message).toMatch(
		/## State\n[\s\S]*\n\n## Recall\n- 記憶: m\d+ 好きな色は藍色（本人の発言）\n\n## User\n好きな色は何だっけ$/,
	);
	expect(asked.at(-1)).toMatchObject({
		text: "好きな色は何だっけ",
		omitShown: false,
		withPrevious: true,
		audience: "host",
	});
	// The record the reply saw stands among the run's inputs: forgetting it expires the reply.
	const sources = h.store.read(
		(db) =>
			h!.memory!.referenceInputs.readRunInTransaction(db, second.id)?.sources,
	);
	expect(sources).toContain(`memory:${saved.id}`);
	// The next turn draws it again or not at all: no earlier message carries the section.
	setting.recallEnabled = false;
	h.state.steps.push(...reply("はい。"));
	await h.say("ありがとう");
	expect(
		h.state.calls
			.at(-1)!
			// The system part names the section; no message of the conversation carries it.
			.messages.slice(1)
			.map((m) => m.content)
			.join("\n"),
	).not.toContain("## Recall");
});
