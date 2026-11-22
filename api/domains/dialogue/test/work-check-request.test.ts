import { afterEach, expect, test } from "bun:test";
import { forgetWork } from "../repository/work";
import { STATE_LIMITS } from "../service/state-text";
import { IMAGE, choice, setup, type Harness } from "./generation.fixture";

/**
 * A TODO cut from `## State` (more than `STATE_LIMITS.work` of them) keeps its request nowhere else: the `work` tool's
 * `check` reads it back, cut as State cuts it, and a forgotten TODO has none to read.
 */
let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

async function doneTodo(request: string) {
	h!.state.steps.push(choice({ choice: IMAGE.id }));
	const waiting = await h!.say(request, "queued");
	await h!.finishImage(waiting.id, { state: "completed", title: "猫" });
	return h!.archived()[0]!;
}

async function checkText(ref: number) {
	h!.state.steps.push(choice({ choice: `t${ref}`, operation: "check" }), {
		text: "はい。",
	});
	await h!.say("さっきの絵はどうなった？");
	return h!.state.calls.at(-1)!.messages.at(-1)!.content;
}

test("check returns the TODO's request cut to the State preview limit", async () => {
	h = await setup();
	const request = `夕暮れの猫の壁紙を作って${"あ".repeat(STATE_LIMITS.preview)}`;
	const todo = await doneTodo(request);
	const text = await checkText(todo.ref);
	expect(text).toContain(
		`- request: ${request.slice(0, STATE_LIMITS.preview)}\n`,
	);
	expect(text).not.toContain(request.slice(0, STATE_LIMITS.preview + 1));
});

test("check of a forgotten TODO returns no request", async () => {
	h = await setup();
	const todo = await doneTodo("忘れてほしい猫の絵");
	await h.store.write((db) => {
		const row = db
			.query("SELECT message_ids_json AS ids FROM dialogue_work WHERE id = ?")
			.get(todo.id) as { ids: string };
		forgetWork(db, JSON.parse(row.ids), new Date().toISOString());
	});
	const text = await checkText(todo.ref);
	expect(text).not.toContain("- request:");
	expect(text).not.toContain("忘れてほしい猫の絵");
});
