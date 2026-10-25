import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { EumenesClient } from "../../../client";
import type { Run } from "../../../api/domains/dialogue/contracts";
import { ErrorReportButton } from "./ErrorReportDialog";
import { RunDetails, RunFailure } from "./RunDetails";
import { describeError } from "../errorMessages";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});
const REPORT =
	"# Eumenes エラーレポート\n## 概要\n- 結果: failed / invalid_control_json";
const run = (patch: Partial<Run>): Run => ({
	id: "run-1",
	agentTaskId: null,
	requestId: "req-1",
	conversationId: "main",
	utteranceId: null,
	status: "failed",
	revision: 1,
	inputMessageId: "m1",
	answerMessageId: null,
	error: "invalid_conversation_operation",
	jobId: null,
	deadlineAt: null,
	sourceKind: "manual",
	scheduleId: null,
	occurrenceId: null,
	specialistSessionId: null,
	createdAt: "2026-10-17T00:00:00.000Z",
	updatedAt: "2026-10-17T00:00:00.000Z",
	...patch,
});

test("the detail button shows the report with the sharing notice and copies the same text", async () => {
	const writeText = vi.fn(async () => {});
	vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
	const runErrorReport = vi.fn(async () => ({ runId: "run-1", text: REPORT }));
	const client = { identity: "t", runErrorReport } as unknown as EumenesClient;
	render(
		<ErrorReportButton
			load={(signal) => client.runErrorReport("run-1", signal)}
			heading="回答を取得できませんでした"
		/>,
	);
	expect(runErrorReport).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "エラーの詳細" }));
	const text = await screen.findByLabelText("エラーレポート本文");
	expect(text.textContent).toBe(REPORT);
	expect(runErrorReport).toHaveBeenCalledWith("run-1", expect.any(AbortSignal));
	expect(
		screen.getByText(
			"IDやエラー発生箇所が含まれます。外部へ共有する前に確認してください",
		),
	).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "レポートをコピー" }));
	expect(
		await screen.findByRole("button", { name: "コピーしました" }),
	).toBeTruthy();
	expect(writeText).toHaveBeenCalledExactlyOnceWith(REPORT);
});

test("a report that cannot be fetched is said so and cannot be copied", async () => {
	const client = {
		identity: "t",
		runErrorReport: vi.fn(async () => {
			throw new Error("offline");
		}),
	} as unknown as EumenesClient;
	render(
		<ErrorReportButton
			load={(signal) => client.runErrorReport("run-1", signal)}
			heading="回答を取得できませんでした"
		/>,
	);
	fireEvent.click(screen.getByRole("button", { name: "エラーの詳細" }));
	expect(
		await screen.findByText("エラーレポートを取得できませんでした。"),
	).toBeTruthy();
	expect(
		(
			screen.getByRole("button", {
				name: "レポートをコピー",
			}) as HTMLButtonElement
		).disabled,
	).toBe(true);
});

test("a failed run shows the error bubble with its cause; a run that did not fail does not", async () => {
	const client = {
		identity: "t",
		runErrorReport: vi.fn(async () => ({ runId: "run-1", text: REPORT })),
	} as unknown as EumenesClient;
	const message = { id: "m1", text: "質問" };
	const cause = describeError(new Error("invalid_conversation_operation"));
	const { rerender } = render(
		<RunDetails
			client={client}
			message={message}
			runs={[run({ status: "failed" })]}
		/>,
	);
	const bubble = screen.getByRole("article", { name: "回答エラー" });
	expect(bubble.textContent).toContain("回答を取得できませんでした");
	expect(bubble.textContent).toContain(cause);
	fireEvent.click(screen.getByRole("button", { name: "エラーの詳細" }));
	const summary = await screen.findByRole("region", { name: "エラーの概要" });
	expect(summary.textContent).toContain(cause);
	expect((await screen.findByLabelText("エラーレポート本文")).textContent).toBe(
		REPORT,
	);
	rerender(
		<RunDetails
			client={client}
			message={message}
			runs={[run({ status: "completed", error: null })]}
		/>,
	);
	expect(screen.queryByRole("article", { name: "回答エラー" })).toBeNull();
});

test("a hidden input's failed run shows the same error bubble; a hidden input that did not fail shows nothing", () => {
	const client = {
		identity: "t",
		runErrorReport: vi.fn(),
	} as unknown as EumenesClient;
	const message = { id: "m1" };
	const { rerender } = render(
		<RunFailure
			client={client}
			message={message}
			runs={[run({ status: "failed", sourceKind: "notice", error: null })]}
		/>,
	);
	const bubble = screen.getByRole("article", { name: "回答エラー" });
	expect(bubble.textContent).toContain("応答に失敗しました");
	expect(screen.getByRole("button", { name: "エラーの詳細" })).toBeTruthy();
	rerender(
		<RunFailure
			client={client}
			message={message}
			runs={[run({ status: "completed", sourceKind: "notice", error: null })]}
		/>,
	);
	expect(screen.queryByRole("article", { name: "回答エラー" })).toBeNull();
});

test("an interrupted run is shown as the assistant's error answer under its name", () => {
	const client = {
		identity: "t",
		runErrorReport: vi.fn(),
	} as unknown as EumenesClient;
	render(
		<RunFailure
			client={client}
			message={{ id: "m1" }}
			runs={[run({ status: "interrupted", error: null })]}
			agentName="ルリ"
		/>,
	);
	const bubble = screen.getByRole("article", { name: "回答エラー" });
	expect(bubble.className).toContain("message-assistant");
	expect(bubble.textContent).toContain("ルリ");
	expect(bubble.textContent).toContain("回答の作成が中断されました");
	expect(screen.getByRole("button", { name: "エラーの詳細" })).toBeTruthy();
});

test("a research that failed and ended as completed shows the detail on its card", async () => {
	const root = {
		id: "root",
		kind: "coordinator" as const,
		rootRunId: "run-1",
		parentTaskId: null,
		packageRevisionId: null,
		status: "completed",
		phase: "completed",
		modelCalls: 2,
		toolCalls: 0,
		errorCode: "web_timeout" as string | null,
		createdAt: "2026-10-17T00:00:00Z",
		deadlineAt: "2026-10-17T00:03:00Z",
		reportState: "none",
	};
	const client = {
		identity: "t",
		agentTasks: vi.fn(async () => [root]),
		toolchainSelections: vi.fn(async () => ({ items: [], nextCursor: null })),
		agentReport: vi.fn(),
		runErrorReport: vi.fn(async () => ({ runId: "run-1", text: REPORT })),
	} as unknown as EumenesClient;
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const message = { id: "m1", text: "株価" };
	const runs = [run({ status: "completed", error: null, agentTaskId: "root" })];
	try {
		render(
			<QueryClientProvider client={cache}>
				<RunDetails client={client} message={message} runs={runs} />
			</QueryClientProvider>,
		);
		expect(
			await screen.findByRole("button", { name: "エラーの詳細" }),
		).toBeTruthy();
		expect(
			screen.getAllByRole("button", { name: "エラーの詳細" }),
		).toHaveLength(1);
		fireEvent.click(screen.getByRole("button", { name: "エラーの詳細" }));
		expect(
			screen.getByRole("region", { name: "エラーの概要" }).textContent,
		).toContain(describeError(new Error("web_timeout")));
		// A clarification request is not a failure.
		root.errorCode = "clarification_required";
		cache.clear();
		cleanup();
		render(
			<QueryClientProvider client={cache}>
				<RunDetails client={client} message={message} runs={runs} />
			</QueryClientProvider>,
		);
		await screen.findByText("調査");
		expect(screen.queryByRole("button", { name: "エラーの詳細" })).toBeNull();
	} finally {
		cache.clear();
	}
});
