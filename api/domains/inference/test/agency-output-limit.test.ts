import { afterEach, expect, test } from "bun:test";
import { cleanup, setup } from "./inference.fixture";

afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});

test("background capture supports the measured F update size while retaining a hard ceiling", async () => {
	const h = await setup();
	const deadline = Date.now() + 30_000;
	const input = {
		taskId: "fixture-structured",
		decisionId: crypto.randomUUID(),
		authorityEpoch: 1,
		executionGeneration: 1,
		deadline,
		taskDeadline: deadline,
		maxOutputTokens: 2400,
		structuredOutput: true,
	} as const;
	const id = await h.store.write((db) =>
		h.inference.captureBackgroundControlInTransaction(db, input),
	);
	expect(id).toBeString();
	await expect(
		h.store.write((db) =>
			h.inference.captureBackgroundControlInTransaction(db, {
				...input,
				decisionId: crypto.randomUUID(),
				maxOutputTokens: 2401,
			}),
		),
	).rejects.toThrow("invalid_background_control");
});
