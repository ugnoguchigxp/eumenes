import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { EumenesClient } from "../../../client";
import type { Run } from "../../../api/domains/dialogue/contracts";
import { ErrorReportButton } from "./ErrorReportDialog";
import { RunDetails } from "./RunDetails";

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
	render(<ErrorReportButton client={client} runId="run-1" />);
	expect(runErrorReport).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "詳細" }));
	const text = await screen.findByLabelText("エラーレポート本文");
	expect(text.textContent).toBe(REPORT);
	expect(runErrorReport).toHaveBeenCalledWith("run-1", expect.any(AbortSignal));
	expect(
		screen.getByText(
			"IDやエラー発生箇所が含まれます。外部へ共有する前に確認してください",
		),
	).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "コピー" }));
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
	render(<ErrorReportButton client={client} runId="run-1" />);
	fireEvent.click(screen.getByRole("button", { name: "詳細" }));
	expect(
		await screen.findByText("エラーレポートを取得できませんでした。"),
	).toBeTruthy();
	expect(
		(screen.getByRole("button", { name: "コピー" }) as HTMLButtonElement)
			.disabled,
	).toBe(true);
});

test("a failed run shows the detail button; a run that did not fail does not", () => {
	const client = {
		identity: "t",
		runErrorReport: vi.fn(),
	} as unknown as EumenesClient;
	const message = { id: "m1", text: "質問" };
	const { rerender } = render(
		<RunDetails
			client={client}
			message={message}
			runs={[run({ status: "failed" })]}
		/>,
	);
	expect(screen.getByRole("button", { name: "詳細" })).toBeTruthy();
	rerender(
		<RunDetails
			client={client}
			message={message}
			runs={[run({ status: "completed", error: null })]}
		/>,
	);
	expect(screen.queryByRole("button", { name: "詳細" })).toBeNull();
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
		runErrorReport: vi.fn(),
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
		expect(await screen.findByRole("button", { name: "詳細" })).toBeTruthy();
		expect(screen.getAllByRole("button", { name: "詳細" })).toHaveLength(1);
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
		expect(screen.queryByRole("button", { name: "詳細" })).toBeNull();
	} finally {
		cache.clear();
	}
});
