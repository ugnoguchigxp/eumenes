import { afterEach, expect, test } from "bun:test";
import { waitFor } from "../../../infrastructure/wait-for";
import { FIXED_TRIGGER_TEXT } from "../service/context-system";
import type {
	AgencyLayerPort,
	GoalsLayerPort,
	WorldContextPort,
} from "../contracts";
import { testConversationAgent } from "./conversation-agent.fixture";
import { setup, type Harness } from "./generation.fixture";

/**
 * The claim-time half of a generation (the ContextWindow specification, sections 5, 7, 8.2 and 12): the material
 * document's fixed keys, the newest message, the trigger, the re-construction a lost cache or a resumed talk calls
 * for, and the window too small to plan.
 */
let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

const minutes = (n: number) => n * 60 * 1000;

/** The material document of the nth model call (messages: system, document, newest). */
function documentOf(call: number) {
	return JSON.parse(h!.state.calls[call]!.messages[1]!.content) as Record<
		string,
		any
	>;
}

test("the material document keeps its fixed keys; the newest message is the utterance itself", async () => {
	h = await setup();
	h.state.steps.push({ text: "ansA" }, { text: "ansB" });
	await h.say("A");
	await h.say("B");
	const second = h.state.calls[1]!;
	expect(second.messages.map((m) => m.role)).toEqual([
		"system",
		"user",
		"user",
	]);
	expect(second.messages[2]!.content).toBe("B");
	const document = documentOf(1);
	expect(Object.keys(document)).toEqual([
		"profile",
		"episode",
		"log",
		"active",
		"state",
		"now",
		"work",
	]);
	// Earlier turns are in the log as events (user said, agent said, delivered); B is the newest message, not an event yet.
	const said = document.log
		.filter((e: { type: string }) => e.type === "said")
		.map((e: { by: string; text: string }) => [e.by, e.text]);
	expect(said).toEqual([
		["user", "A"],
		["agent", "ansA"],
	]);
	expect(document.log.some((e: { text?: string }) => e.text === "B")).toBe(
		false,
	);
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
	expect(documentOf(0).now.trigger).toEqual([notice]);
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
	expect(documentOf(0).now.trigger).toEqual([
		{ kind: "notice", text: "タイマーが終わりました" },
	]);
});

test("the conversation agent's state shows in now.agency, as lines; nothing else of it is in the document", async () => {
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
	const document = documentOf(0);
	expect(document.now.agency).toEqual([
		"関心: マイメロディ",
		"言いたいこと: 昨日の天気",
	]);
});

test("an empty agency layer, or none, leaves now.agency empty", async () => {
	h = await setup({
		agency: {
			stateForContextInTransaction: () => [],
			workChangedInTransaction: () => {},
		},
	});
	h.state.steps.push({ text: "はい。" });
	await h.say("こんにちは");
	expect(documentOf(0).now.agency).toEqual([]);
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

test("the world names the wording mentions are a reference record in now.records", async () => {
	const worldContext: WorldContextPort = {
		knownNamesInTransaction: () => ["箱根"],
	};
	h = await setup({ worldContext });
	h.state.steps.push({ text: "はい。" });
	await h.say("箱根のことを教えて");
	const records = documentOf(0).now.records as Array<{
		source: string;
		authority: string;
		text: string;
	}>;
	expect(records).toEqual([
		expect.objectContaining({
			source: "world.names",
			authority: "reference",
			text: expect.stringContaining("「箱根」"),
		}),
	]);
});

test("adopted goals are the state's goals, each with its id and text (the priority orders them and stays host-side)", async () => {
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
	expect(documentOf(0).state.goals).toEqual([
		{ id: "g1", text: "毎日少し運動する" },
	]);
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
	h.state.steps.push({ text: "一つ目。" }, { text: "再開。" });
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
	const document = documentOf(1);
	// No summary is prepared yet (section 8.3): the earlier turn is not moved to the episode, its text stays.
	expect(document.episode).toEqual([]);
	expect(document.log.map((e: { text?: string }) => e.text)).toContain(
		"一つ目",
	);
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
