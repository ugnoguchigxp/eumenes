import { afterEach, expect, test } from "bun:test";
import { configureLogging } from "../../../infrastructure/logger";
import { INSTANT, setup, type Harness } from "./generation.fixture";

/** A cut completes no choice, on either attempt; only host refusals may cause another choice. */
let h: Harness | undefined;
afterEach(async () => {
	try {
		await h?.close();
	} finally {
		h = undefined;
		configureLogging({ level: "silent" });
	}
});

test.each([1, 2])(
	"a cut on choice attempt %i passes to talk and keeps its cut log",
	async (attempt) => {
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
		if (attempt === 2) {
			h.state.steps.push({
				text: JSON.stringify({ choice: INSTANT.id, inputs: {} }),
			});
		}
		h.state.steps.push(
			{ fail: "chat_stream_incomplete" },
			{ text: "決めきれませんでした。" },
			// Let the old retry path finish too, so a regression fails on counts rather than a missing fixture reply.
			{ text: "決めきれませんでした。" },
		);
		const run = await h.say("東京は今何時？");
		expect(run.status).toBe("completed");
		expect(h.dialogue.answerText(run.id)).toBe("決めきれませんでした。");
		expect(h.state.calls).toHaveLength(attempt + 1);
		expect(
			h.state.calls.filter((call) => call.session?.outputSchema),
		).toHaveLength(attempt);
		const talk = h.state.calls.at(-1)!;
		expect(talk.session?.outputSchema).toBeUndefined();
		expect(talk.tools).toEqual(["read_history", "read_runs"]);
		expect(talk.messages.at(-1)!.content).not.toContain("## Retry");
		const choices = records.filter(
			(record) => record.event === "dialogue.choice_made",
		);
		expect(choices).toHaveLength(attempt);
		expect(choices.at(-1)).toMatchObject({
			kind: "request",
			decision: "cut",
			attempt,
		});
		expect(JSON.stringify(choices)).not.toContain("東京は今何時？");
		expect(JSON.stringify(choices)).not.toContain("決めきれませんでした。");
	},
);
