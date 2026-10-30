import { afterEach, expect, test } from "bun:test";
import { readChatResponse } from "../../../infrastructure/chat-stream";
import { cleanup, setup, freshSignal, messages } from "./inference.fixture";

afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});

/** A provider counts both reasoning and the JSON answer toward max_tokens. */
async function background(thinkingTokens: number, providerOutputLimit = 4096) {
	const answerTokens = 1200;
	const generatedAnswerTokens = 512;
	const answer = JSON.stringify({ changed: false, items: [] });
	const h = await setup({
		local: async (_messages, signal, options) => {
			const complete =
				Math.min(providerOutputLimit, options?.maxOutputTokens ?? 0) >=
				thinkingTokens + generatedAnswerTokens;
			const result = await readChatResponse(
				Response.json({
					choices: [
						{
							message: {
								reasoning_content: "reasoning".repeat(thinkingTokens),
								content: complete ? answer : '{"changed":',
							},
							finish_reason: complete ? "stop" : "length",
						},
					],
				}),
				signal,
			);
			return result.text;
		},
	});
	const deadline = Date.now() + 90_000;
	const id = await h.store.write((db) =>
		h.inference.captureBackgroundControlInTransaction(db, {
			taskId: "background-budget",
			decisionId: crypto.randomUUID(),
			authorityEpoch: 1,
			executionGeneration: 1,
			deadline,
			taskDeadline: deadline,
			maxOutputTokens: answerTokens,
			structuredOutput: true,
		}),
	);
	return { ...h, id, answer };
}

test("background control completes after long reasoning while respecting the provider's output cap", async () => {
	// The reported failure consumed all 3248 available tokens before the answer was complete.
	const h = await background(3248);
	const receipt = await h.inference.executeControl(
		h.id,
		messages,
		freshSignal(),
	);
	expect(receipt.value).toBe(h.answer);
	expect(
		await h.store.write((db) => h.inference.acceptInTransaction(db, receipt)),
	).toBe(true);
});

test("background control has room for 10000 reasoning tokens when the provider supports it", async () => {
	const h = await background(10_000, 20_000);
	const receipt = await h.inference.executeControl(
		h.id,
		messages,
		freshSignal(),
	);
	expect(receipt.value).toBe(h.answer);
	expect(
		await h.store.write((db) => h.inference.acceptInTransaction(db, receipt)),
	).toBe(true);
});

test.each([4096, 20_000])(
	"a response truncated at provider cap %i is rejected without accepting partial JSON",
	async (limit) => {
		const h = await background(12_000, limit);
		await expect(
			h.inference.executeControl(h.id, messages, freshSignal()),
		).rejects.toThrow("chat_stream_incomplete");
		expect(
			h.store.read((db) =>
				db.query("SELECT status FROM inference_requests WHERE id=?").get(h.id),
			),
		).toEqual({ status: "failed" });
		expect(h.calls).toHaveLength(0);
	},
);
