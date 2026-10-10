import { expect, test } from "bun:test";
import { reportSchema } from ".";
test("the report contract advertises and enforces the shared UTF-8 storage limit", () => {
	const report = {
		reportId: crypto.randomUUID(),
		commandId: "command",
		taskId: "task",
		authorityEpoch: 1,
		executionGeneration: 1,
		sourceSequence: 1,
		kind: "progress",
		summary: "報告",
		facts: Array(8).fill("あ".repeat(600)),
		limitations: Array(8).fill("あ".repeat(600)),
	};
	expect(reportSchema.safeParse(report).success).toBe(false);
	expect(
		reportSchema.parse({
			...report,
			facts: ["あ".repeat(600)],
			limitations: [],
		}).summary,
	).toBe("報告");
});
