import { afterEach, expect, test } from "bun:test";
import { waitFor } from "../../../infrastructure/wait-for";
import { FIXED_TRIGGER_TEXT } from "../service/context-system";
import type {
	AgencyLayerPort,
	GoalsLayerPort,
	WorldContextPort,
} from "../contracts";
import { testConversationAgent } from "./conversation-agent.fixture";
import { sectionLines, setup, type Harness } from "./generation.fixture";

/**
 * The claim-time half of a generation (the ContextWindow layout specification, sections 4, 5, 7, 8.2 and 12): the
 * material document's four sections, the `<now>` of the last message, the trigger, the re-construction a lost cache
 * or a resumed talk calls for, and the window too small to plan.
 */
let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

const minutes = (n: number) => n * 60 * 1000;

/** The material document (the second message) of the nth model call. */
function documentOf(call: number): string {
	return h!.state.calls[call]!.messages[1]!.content;
}

/** The lines of the `<now>` block (the third message) of the nth model call, without its tags. */
function nowOf(call: number): string[] {
	return sectionLines(h!.state.calls[call]!.messages[2]!.content, "now");
}

test("the material document is four tagged sections in order; the newest message is the utterance itself", async () => {
	h = await setup();
	h.state.steps.push({ text: "ansA" }, { text: "ansB" });
	await h.say("A");
	await h.say("B");
	const second = h.state.calls[1]!;
	expect(second.messages.map((m) => m.role)).toEqual([
		"system",
		"user",
		"user",
		"user",
	]);
	expect(second.messages[3]!.content).toBe("B");
	// The `<now>` block is the third message, not a part of the document.
	expect(second.messages[2]!.content.startsWith("<now>\n")).toBe(true);
	const document = documentOf(1);
	const order = ["<memory>", "<history>", "<log>", "<state>"].map((tag) =>
		document.indexOf(tag),
	);
	expect(order.every((at) => at >= 0)).toBe(true);
	expect([...order].sort((a, b) => a - b)).toEqual(order);
	// Earlier turns are in the log as lines (user said, agent said); B is the newest message, not an event yet.
	const log = sectionLines(document, "log");
	expect(log.some((line) => /^e\d+ \d{2}:\d{2} 利用者: A$/.test(line))).toBe(
		true,
	);
	expect(log.some((line) => /^e\d+ \d{2}:\d{2} 自分: ansA$/.test(line))).toBe(
		true,
	);
	expect(log.some((line) => line.endsWith("利用者: B"))).toBe(false);
});

test("a notice whose text is a JSON object is the trigger; the fixed text is the newest message when no utterance is pending", async () => {
	h = await setup();
	h.state.steps.push({ text: "通知を伝えます。" });
	const notice = { kind: "task_result", status: "completed", title: "猫の絵" };
	const run = await h.dialogue.notify({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: JSON.stringify(notice),
	});
	await waitForRun(run.id);
	const call = h.state.calls[0]!;
	expect(call.messages.at(-1)!.content).toBe(FIXED_TRIGGER_TEXT);
	// The object is the trigger: its kind leads the line, its other fields follow as JSON.
	expect(nowOf(0)).toContain(
		'きっかけ task_result {"status":"completed","title":"猫の絵"}',
	);
});

test("a plain notice text is the trigger as its source kind and text", async () => {
	h = await setup();
	h.state.steps.push({ text: "お知らせです。" });
	const run = await h.dialogue.notify({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "タイマーが終わりました",
	});
	await waitForRun(run.id);
	expect(nowOf(0)).toContain(
		'きっかけ notice {"text":"タイマーが終わりました"}',
	);
});

test("the conversation agent's state shows in <now> as agency lines; nothing else of it is in the document", async () => {
	const agency: AgencyLayerPort = {
		stateForContextInTransaction: () => [
			"関心: マイメロディ",
			"言いたいこと: 昨日の天気",
		],
		workChangedInTransaction: () => {},
	};
	h = await setup({ agency });
	h.state.steps.push({ text: "はい。" });
	await h.say("こんにちは");
	const now = nowOf(0);
	expect(now).toContain("agency 関心: マイメロディ");
	expect(now).toContain("agency 言いたいこと: 昨日の天気");
	expect(documentOf(0)).not.toContain("マイメロディ");
	expect(documentOf(0)).not.toContain("昨日の天気");
});

test("an empty agency layer, or none, leaves no agency line in <now>", async () => {
	h = await setup({
		agency: {
			stateForContextInTransaction: () => [],
			workChangedInTransaction: () => {},
		},
	});
	h.state.steps.push({ text: "はい。" });
	await h.say("こんにちは");
	expect(nowOf(0).some((line) => line.startsWith("agency "))).toBe(false);
});

test("the system message leads with the conversation agent's own system text, then the host's persona and rules", async () => {
	h = await setup({
		conversationAgent: {
			system: () => "AGENT-SYSTEM-TEXT",
			respond: testConversationAgent.respond,
		},
	});
	h.state.steps.push({ text: "はい。" });
	await h.say("こんにちは");
	const system = h.state.calls[0]!.messages[0]!;
	expect(system.role).toBe("system");
	expect(system.content.startsWith("AGENT-SYSTEM-TEXT\n")).toBe(true);
	expect(system.content.length).toBeGreaterThan(
		"AGENT-SYSTEM-TEXT".length + 50,
	);
});

test("the world names the wording mentions are a reference record line in <now>, not in the document", async () => {
	const worldContext: WorldContextPort = {
		knownNamesInTransaction: () => ["箱根"],
	};
	h = await setup({ worldContext });
	h.state.steps.push({ text: "はい。" });
	await h.say("箱根のことを教えて");
	const records = nowOf(0).filter((line) => line.startsWith("資料 "));
	expect(records).toHaveLength(1);
	expect(records[0]).toMatch(/^資料 world\.names: .*箱根/);
	expect(documentOf(0)).not.toContain("箱根");
});

test("adopted goals are the state's goals, each as a numbered line with its text", async () => {
	const goals: GoalsLayerPort = {
		adoptedForContextInTransaction: () => [
			{
				goalId: "g1",
				priority: 1,
				desiredState: "毎日少し運動する",
				revision: 1,
			},
		],
		existingInTransaction: () => new Set(["g1"]),
	};
	h = await setup({ goals });
	h.state.steps.push({ text: "はい。" });
	await h.say("今日の予定は");
	expect(sectionLines(documentOf(0), "state")).toContain(
		"g1 目標 毎日少し運動する",
	);
});

test("a conversation idle past the provider's cache window is re-constructed; a quick follow-up is not", async () => {
	h = await setup();
	h.state.steps.push(
		{ text: "一つ目。" },
		{ text: "二つ目。" },
		{ text: "三つ目。" },
	);
	await h.say("一つ目");
	const version = () =>
		h!.store.read(
			(db) =>
				h!.continuity.events.windowVersionInTransaction(db, "main").version,
		);
	const afterFirst = version();
	await h.say("二つ目");
	expect(version()).toBe(afterFirst);
	h.state.offsetMs += minutes(7);
	await h.say("三つ目");
	expect(version()).toBeGreaterThan(afterFirst);
});

test("a resumed conversation (silence of half an hour) is re-constructed; the original turns stay in the log until their summary is prepared", async () => {
	h = await setup();
	h.state.steps.push(
		{ text: "一つ目。" },
		{ text: "再開。" },
		{ text: "次。" },
	);
	await h.say("一つ目");
	const version = () =>
		h!.store.read(
			(db) =>
				h!.continuity.events.windowVersionInTransaction(db, "main").version,
		);
	const before = version();
	h.state.offsetMs += minutes(31);
	await h.say("戻りました");
	expect(version()).toBeGreaterThan(before);
	// No summary is prepared yet (layout specification, section 8.3): nothing is in <history>, and the earlier turn
	// stays in <log>.
	const document = documentOf(1);
	expect(sectionLines(document, "history")).toEqual([]);
	expect(
		sectionLines(document, "log").some((line) =>
			/^e\d+ \d{2}:\d{2} 利用者: 一つ目$/.test(line),
		),
	).toBe(true);
	// The resumed turn is logged once it is handled; the next document shows the resume line before it (section 7).
	await h.say("次は");
	const log = sectionLines(documentOf(2), "log");
	const resume = log.findIndex((line) => line.startsWith("--- 再開 "));
	const back = log.findIndex((line) => line.endsWith("利用者: 戻りました"));
	expect(resume).toBeGreaterThanOrEqual(0);
	expect(back).toBeGreaterThan(resume);
});

test("a window too small for the planned sections fails the run with window_too_small, with no model call", async () => {
	h = await setup({ window: 12_000 });
	const run = await h.say("こんにちは", "failed");
	expect(run.error).toBe("window_too_small");
	expect(h.state.calls).toHaveLength(0);
});

/** Waits until the run has left the queue (completed or failed). */
async function waitForRun(runId: string) {
	await waitFor(() =>
		["completed", "failed", "cancelled"].includes(
			h!.dialogue.get(runId)?.status ?? "",
		),
	);
}
