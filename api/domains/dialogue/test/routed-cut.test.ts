import { afterEach, expect, test } from "bun:test";
import { configureLogging } from "../../../infrastructure/logger";
import { INSTANT, choice, setup, type Harness } from "./generation.fixture";

/** A fill cut at the output limit completes nothing: the talk turn answers, and the log keeps the cut. */
let h: Harness | undefined;
afterEach(async () => {
	try {
		await h?.close();
	} finally {
		h = undefined;
		configureLogging({ level: "silent" });
	}
});

test("a fill cut at the output limit passes to talk and keeps its log, with none of the words", async () => {
	const records: Array<Record<string, unknown>> = [];
	configureLogging({
		level: "info",
		destination: {
			write: (line) => {
				records.push(JSON.parse(line));
			},
		},
	});
	h = await setup();
	// The router decides the clock (it has inputs to fill); the fill is cut.
	h.state.steps.push(
		choice({ choice: INSTANT.id }),
		{ fail: "chat_stream_incomplete" },
		{ text: "決めきれませんでした。" },
	);
	const run = await h.say("東京は今何時？");
	expect(run.status).toBe("completed");
	expect(h.dialogue.answerText(run.id)).toBe("決めきれませんでした。");
	expect(h.state.calls).toHaveLength(2);
	expect(h.state.calls[0]!.session?.outputSchema).toBeDefined();
	const talk = h.state.calls.at(-1)!;
	expect(talk.session?.outputSchema).toBeUndefined();
	expect(talk.tools).toEqual(["read_history", "read_runs"]);
	const fills = records.filter(
		(record) => record.event === "dialogue.choice_made",
	);
	expect(fills).toEqual([
		expect.objectContaining({ kind: "fill", decision: "unreadable" }),
	]);
	expect(JSON.stringify(fills)).not.toContain("東京は今何時？");
	expect(JSON.stringify(fills)).not.toContain("決めきれませんでした。");
});
