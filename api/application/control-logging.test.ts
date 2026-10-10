import { afterEach, expect, test } from "bun:test";
import { configureLogging } from "../infrastructure/logger";
import { harness, forbidden } from "./toolchain.fixture";

afterEach(() => configureLogging({ level: "silent" }));
function capture() {
	const lines: string[] = [];
	configureLogging({
		level: "info",
		destination: {
			write: (line) => {
				lines.push(line);
			},
		},
	});
	return { lines, entries: () => lines.map((line) => JSON.parse(line)) };
}
async function run(h: Awaited<ReturnType<typeof harness>>) {
	const response = await h.request("/api/runs", {
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "東京の天気を調べて PRIVATE_REQUEST",
	});
	expect(response.status).toBe(202);
	const run = await response.json();
	expect(
		(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
	).toBe("completed");
	return run;
}

test("an unknown tool name invokes nothing and receives one bounded correction", async () => {
	const output = capture();
	const h = await harness({ badExecutionRefOnce: true, fullResearch: true });
	try {
		const r = await run(h);
		expect(h.acquisitions).toBe(2);
		expect(h.dialogue.answerText(r.id)).toContain("26度");
		const issues = output
			.entries()
			.filter((entry) => entry.event === "agent.control_validation_issue");
		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({
			validationPath: "tool",
			validationCode: "unknown_tool",
		});
		const repairIndex = h.workerContexts.findIndex((context) =>
			context.includes("一度だけ修正"),
		);
		expect(repairIndex).toBeGreaterThanOrEqual(0);
		expect(h.workerContexts[repairIndex]).toContain("invalid_tool_input");
		expect(
			h.workerContexts
				.slice(repairIndex + 1)
				.some((context) => context.includes("一度だけ修正")),
		).toBe(false);
	} finally {
		await h.close();
	}
});

test("search timeout, successful retry and malformed report are correlated and separately diagnosed", async () => {
	const output = capture();
	const h = await harness({
		fullResearch: true,
		lookupTimeoutOnce: true,
		workerReportOutput: '{"action":',
	});
	try {
		const r = await run(h);
		const rows = output.entries();
		const failed = rows.find((entry) => entry.event === "agent.tool_failed");
		expect(failed).toMatchObject({
			runId: r.id,
			reason: "web_timeout",
			status: "failed",
		});
		expect(rows.find((entry) => entry.event === "web.failed")).toMatchObject({
			jobId: failed.jobId,
			runId: failed.operationId,
			reason: "web_timeout",
			kind: "lookup",
		});
		expect(
			rows.find(
				(entry) =>
					entry.event === "queue.settled" && entry.jobId === failed.jobId,
			),
		).toMatchObject({ reason: "web_timeout", status: "failed" });
		const completed = rows.find(
			(entry) =>
				entry.event === "agent.tool_completed" &&
				entry.kind === "tool:web.lookup@1",
		);
		expect(completed).toMatchObject({ runId: r.id, status: "succeeded" });
		expect(
			rows.find(
				(entry) =>
					entry.event === "web.completed" && entry.jobId === completed.jobId,
			),
		).toMatchObject({ hitCount: 1, documentCount: 0, failureCount: 0 });
		const rejected = rows.filter(
			(entry) => entry.event === "agent.control_rejected",
		);
		expect(rejected).toHaveLength(2);
		expect(rejected[0]).toMatchObject({
			runId: r.id,
			taskId: failed.taskId,
			controlSchema: "worker",
			reason: "control_json_syntax",
			validationCode: "unexpected_end",
			repairAttempt: 0,
			status: "repair_scheduled",
		});
		expect(rejected[1]).toMatchObject({
			reason: "control_json_syntax",
			repairAttempt: 1,
			status: "failed",
		});
		for (const row of rejected) {
			expect(row.stepId).toBeTruthy();
			expect(row.inferenceId).toBeTruthy();
			expect(row.attemptId).toBeTruthy();
		}
		const text = output.lines.join("");
		for (const secret of [
			forbidden,
			"PRIVATE_REQUEST",
			'{"action":',
			"fixture-token-for-toolchain",
		])
			expect(text).not.toContain(secret);
	} finally {
		await h.close();
	}
});

test("valid JSON with a missing report field records the field and expected type, not its private contents", async () => {
	const output = capture();
	const h = await harness({
		workerOutput: JSON.stringify({
			action: "finish",
			report: {
				outcome: "answered",
				claims: [
					{
						text: "PRIVATE_CLAIM",
						evidence: ["e1"],
					},
				],
				limitations: [],
				PRIVATE_KEY: "PRIVATE_VALUE",
			},
		}),
	});
	try {
		const r = await run(h);
		const issue = output
			.entries()
			.find(
				(entry) =>
					entry.event === "agent.control_validation_issue" &&
					entry.validationPath === "requirements",
			);
		expect(issue).toMatchObject({
			runId: r.id,
			reason: "control_schema_invalid",
			validationCode: "invalid_type",
			expectedType: "array",
			actualType: "undefined",
			controlAction: "finish",
			issueCount: 5,
			reportedIssueCount: 5,
		});
		expect(
			output
				.entries()
				.filter((entry) => entry.event === "agent.control_rejected"),
		).toHaveLength(2);
		expect(output.lines.join("")).not.toContain("PRIVATE");
		const feedback = JSON.parse(h.workerContexts[1]!).find(
			(message: { content: string }) =>
				message.content.includes("一度だけ修正"),
		);
		expect(feedback.content).toContain("invalid_control_json");
		expect(feedback.content).not.toContain("PRIVATE");
	} finally {
		await h.close();
	}
});

for (const options of [{ badToolArgs: true }, { badQuote: true }])
	test(`action rejection logs precise diagnostics: ${JSON.stringify(options)}`, async () => {
		const output = capture();
		const h = await harness(options);
		try {
			const r = await run(h);
			const issues = output
				.entries()
				.filter((entry) => entry.event === "agent.control_validation_issue");
			expect(
				issues.some(
					(entry) =>
						entry.runId === r.id &&
						(options.badToolArgs
							? entry.reason === "invalid_tool_input" &&
								entry.validationPath === "arguments.query" &&
								entry.expectedType === "string"
							: entry.reason === "invalid_evidence" &&
								entry.validationPath === "report.evidence" &&
								entry.validationCode === "unknown_evidence"),
				),
			).toBe(true);
			expect(output.lines.join("")).not.toContain(forbidden);
			const repair = h.workerContexts.find((context) =>
				context.includes("一度だけ修正"),
			);
			expect(repair).toContain(
				options.badToolArgs ? "invalid_tool_input" : "invalid_evidence",
			);
		} finally {
			await h.close();
		}
	});
