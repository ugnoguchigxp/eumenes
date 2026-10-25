import { afterEach, expect, test } from "bun:test";
import type {
	GoalsLayerPort,
	WorldContextNamesInput,
	WorldContextPort,
} from "../contracts";
import { waitFor } from "../../../infrastructure/wait-for";
import { setup, type Harness } from "./generation.fixture";

/**
 * What the conversation's prompt takes from World and Goals (the ContextWindow specification, sections 5.2 and
 * 13): World shows only the names of the known targets this turn's wording mentions, as a reference record, and a
 * goal FORGET while the answer is generated makes that answer stale, while other goal changes do not.
 */
let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

const HINT_NAME = "音声サービス";

/** The records of the nth model call's document, by source. */
function recordsOf(call: number) {
	const document = JSON.parse(h!.state.calls[call]!.messages[1]!.content) as {
		now: {
			records?: Array<{ source: string; authority: string; text: string }>;
		};
	};
	// A document with no record leaves the key out (section 5.2).
	return document.now.records ?? [];
}

test("the names World knows for the wording are one reference record; the wording is the port's input", async () => {
	const asked: WorldContextNamesInput[] = [];
	const worldContext: WorldContextPort = {
		knownNamesInTransaction: (_db, input) => {
			asked.push(input);
			return [HINT_NAME];
		},
	};
	h = await setup({ worldContext });
	h.state.steps.push({ text: "9月から利用できます。" });
	await h.say("音声サービスはいつから使える？");
	expect(asked.at(-1)!.conversationId).toBe("main");
	expect(asked.at(-1)!.texts.join("\n")).toContain(
		"音声サービスはいつから使える？",
	);
	const records = recordsOf(0);
	expect(records).toEqual([
		expect.objectContaining({ source: "world.names", authority: "reference" }),
	]);
	// Only the name is shown, quoted; no content or identifier of the target.
	expect(records[0]!.text).toContain(`「${HINT_NAME}」`);
});

test("no known target named: no record is shown", async () => {
	const worldContext: WorldContextPort = { knownNamesInTransaction: () => [] };
	h = await setup({ worldContext });
	h.state.steps.push({ text: "はい。" });
	await h.say("こんにちは");
	expect(recordsOf(0)).toEqual([]);
});

test("World off (no port): no record, and the answer is produced as before", async () => {
	h = await setup();
	h.state.steps.push({ text: "はい。" });
	const run = await h.say("音声サービスはいつから使える？");
	expect(recordsOf(0)).toEqual([]);
	expect(h.dialogue.answerText(run.id)).toBe("はい。");
});

/** Goals whose existence the test controls: a forgotten goal is removed from `existing`. */
function goalsPort(shown: string[], existing: Set<string>): GoalsLayerPort {
	return {
		adoptedForContextInTransaction: () =>
			shown.map((goalId, i) => ({
				goalId,
				priority: i + 1,
				desiredState: `目標${goalId}`,
				revision: 1,
			})),
		existingInTransaction: (_db, goalIds) =>
			new Set(goalIds.filter((id) => existing.has(id))),
	};
}

test("a goal shown in the prompt and forgotten while the answer is generated makes the run memory_stale", async () => {
	const existing = new Set(["g1"]);
	h = await setup({ goals: goalsPort(["g1"], existing) });
	let release!: () => void;
	h.state.gate = new Promise<void>((resolve) => (release = resolve));
	h.state.steps.push({ text: "はい。" });
	const run = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "今日の予定は",
	});
	await waitForStatus(run.id, "running");
	existing.delete("g1");
	release();
	await waitForStatus(run.id, "failed");
	expect(h.dialogue.get(run.id)?.error).toBe("memory_stale");
	expect(h.conversation.get("main").messages.map((m) => m.role)).toEqual([
		"user",
	]);
});

test("revising a goal shown in the prompt while the answer is generated does not stale the run", async () => {
	const existing = new Set(["g1"]);
	h = await setup({ goals: goalsPort(["g1"], existing) });
	let release!: () => void;
	h.state.gate = new Promise<void>((resolve) => (release = resolve));
	h.state.steps.push({ text: "はい。" });
	const run = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "今日の予定は",
	});
	await waitForStatus(run.id, "running");
	// The goal's text changes but it still exists: nothing the prompt stood on is gone.
	release();
	await waitForStatus(run.id, "completed");
	expect(h.dialogue.answerText(run.id)).toBe("はい。");
});

test("forgetting a goal that was not shown in the prompt does not stale the run", async () => {
	const existing = new Set(["g1", "g2"]);
	h = await setup({ goals: goalsPort(["g1"], existing) });
	let release!: () => void;
	h.state.gate = new Promise<void>((resolve) => (release = resolve));
	h.state.steps.push({ text: "はい。" });
	const run = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "今日の予定は",
	});
	await waitForStatus(run.id, "running");
	existing.delete("g2");
	release();
	await waitForStatus(run.id, "completed");
});

test("with no goal shown, a goal adopted while the answer is generated does not stale the run", async () => {
	const existing = new Set<string>();
	let adopted: string[] = [];
	const goals: GoalsLayerPort = {
		adoptedForContextInTransaction: () =>
			adopted.map((goalId) => ({
				goalId,
				priority: 1,
				desiredState: "新しい目標",
				revision: 1,
			})),
		existingInTransaction: (_db, goalIds) =>
			new Set(goalIds.filter((id) => existing.has(id))),
	};
	h = await setup({ goals });
	let release!: () => void;
	h.state.gate = new Promise<void>((resolve) => (release = resolve));
	h.state.steps.push({ text: "はい。" });
	const run = await h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "今日の予定は",
	});
	await waitForStatus(run.id, "running");
	adopted = ["g9"];
	existing.add("g9");
	release();
	await waitForStatus(run.id, "completed");
});

/** Waits until the run has reached `status` (a failed or completed run is read as it stands). */
async function waitForStatus(runId: string, status: string) {
	await waitFor(() => h!.dialogue.get(runId)?.status === status);
}
