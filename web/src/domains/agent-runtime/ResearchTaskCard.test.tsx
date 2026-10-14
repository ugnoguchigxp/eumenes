import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { EumenesClient } from "../../../../client";
import { queryRoots } from "../../queryKeys";
import { ResearchTaskCard } from "./ResearchTaskCard";
afterEach(cleanup);
const root = {
	id: "root",
	kind: "coordinator" as const,
	rootRunId: "run",
	parentTaskId: null,
	packageRevisionId: null,
	status: "completed",
	phase: "completed",
	modelCalls: 2,
	toolCalls: 0,
	errorCode: null as string | null,
	createdAt: "2026-10-09T00:00:00Z",
	deadlineAt: "2026-10-09T00:03:00Z",
	reportState: "available",
};
for (const functionName of ["web_search", "web_research"])
	test(`the research card identifies the selected ${functionName} tool`, async () => {
		const client = {
			identity: `tool-${functionName}`,
			agentTasks: vi.fn(async () => [root]),
			toolchainSelections: vi.fn(async () => ({
				items: [{ decision: "toolchain", functionName }],
				nextCursor: null,
			})),
			agentReport: vi.fn(async () => ({
				summary: "調査結果",
				claims: [],
				limitations: [],
				sources: [],
				coverage: "complete",
			})),
		} as unknown as EumenesClient;
		const cache = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		try {
			render(
				<QueryClientProvider client={cache}>
					<ResearchTaskCard client={client} rootRunId="run" title="株価" />
				</QueryClientProvider>,
			);
			expect(
				await screen.findByText(`使用ツール: ${functionName}`),
			).toBeTruthy();
			expect(client.toolchainSelections).toHaveBeenCalledExactlyOnceWith(
				{ runId: "run", limit: 1 },
				expect.any(AbortSignal),
			);
		} finally {
			cache.clear();
		}
	});
test("deleted reports disappear even when a previous response remains in the query cache", async () => {
	let current = root;
	const client = {
		identity: "card",
		agentTasks: vi.fn(async () => [current]),
		toolchainSelections: vi.fn(async () => ({ items: [], nextCursor: null })),
		agentReport: vi.fn(async () => ({
			summary: "OLD_REPORT",
			claims: [],
			limitations: [],
			sources: [],
			coverage: "complete",
		})),
	} as unknown as EumenesClient;
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	try {
		render(
			<QueryClientProvider client={cache}>
				<ResearchTaskCard client={client} rootRunId="run" title="東京の天気" />
			</QueryClientProvider>,
		);
		await screen.findByText("OLD_REPORT");
		const details = screen.getByText("OLD_REPORT").closest("details")!;
		expect(details.open).toBe(true);
		fireEvent.click(screen.getByText("調査の詳細・出典"));
		expect(details.open).toBe(false);
		current = { ...root, reportState: "deleted" };
		await cache.invalidateQueries({ queryKey: [queryRoots.agentTasks] });
		await vi.waitFor(() => expect(screen.queryByText("OLD_REPORT")).toBeNull());
		expect(screen.getByText("調査の詳細は削除されました。")).toBeTruthy();
		expect(client.agentReport).toHaveBeenCalledTimes(1);
		expect(
			cache.getQueryData([queryRoots.agentReports, client.identity, "run"]),
		).toBeUndefined();
	} finally {
		cache.clear();
	}
});
test("failed research stays a status indicator; the agent's response supplies the spoken explanation", async () => {
	const client = {
		identity: "failed-card",
		agentTasks: vi.fn(async () => [
			{ ...root, reportState: "none", errorCode: "invalid_evidence" },
		]),
		toolchainSelections: vi.fn(async () => ({ items: [], nextCursor: null })),
		agentReport: vi.fn(),
	} as unknown as EumenesClient;
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	try {
		render(
			<QueryClientProvider client={cache}>
				<ResearchTaskCard client={client} rootRunId="run" title="東京の天気" />
			</QueryClientProvider>,
		);
		await screen.findByText("調査未完了");
		const activity = screen.getByRole("complementary", {
			name: "調査: 東京の天気",
		});
		expect(activity.closest(".message")).toBeNull();
		expect(screen.queryByText("Eumenes")).toBeNull();
		expect(screen.queryByText("東京の天気")).toBeNull();
		expect(screen.queryByText("完了")).toBeNull();
		expect(screen.queryByText(/もう一度依頼してください/)).toBeNull();
		expect(client.agentReport).not.toHaveBeenCalled();
	} finally {
		cache.clear();
	}
});
test("the card shows the acquisition mode taken from the persisted task state", async () => {
	const client = {
		identity: "mode-card",
		agentTasks: vi.fn(async () => [
			{
				...root,
				status: "waiting_child",
				reportState: "none",
				phase: "research",
			},
			{
				...root,
				id: "child",
				kind: "worker" as const,
				parentTaskId: "root",
				status: "running",
				phase: "read",
				reportState: "none",
				acquisitionMode: "cached" as const,
			},
		]),
		toolchainSelections: vi.fn(async () => ({ items: [], nextCursor: null })),
		agentReport: vi.fn(),
	} as unknown as EumenesClient;
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	try {
		render(
			<QueryClientProvider client={cache}>
				<ResearchTaskCard client={client} rootRunId="run" title="鎌倉の天気" />
			</QueryClientProvider>,
		);
		await screen.findByText("登録サイトを確認");
		expect(screen.getByText("資料を確認中")).toBeTruthy();
		expect(screen.queryByText("鎌倉の天気")).toBeNull();
		expect(screen.getByText("登録サイトを確認").closest("details")?.open).toBe(
			true,
		);
	} finally {
		cache.clear();
	}
});

test("ordinary replies do not leave an empty assistant activity bubble", async () => {
	const client = {
		identity: "ordinary-card",
		agentTasks: vi.fn(async () => [{ ...root, reportState: "none" }]),
		toolchainSelections: vi.fn(),
		agentReport: vi.fn(),
	} as unknown as EumenesClient;
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	try {
		const { container } = render(
			<QueryClientProvider client={cache}>
				<ResearchTaskCard client={client} rootRunId="run" title="こんにちは" />
			</QueryClientProvider>,
		);
		await vi.waitFor(() =>
			expect(
				cache.getQueryState([queryRoots.agentTasks, client.identity, "run"])
					?.status,
			).toBe("success"),
		);
		expect(container.querySelector(".research-activity")).toBeNull();
		expect(client.toolchainSelections).not.toHaveBeenCalled();
	} finally {
		cache.clear();
	}
});

test("a replaced route shows the rediscovery mode instead of a plain search", async () => {
	const client = {
		identity: "card-rediscover",
		agentTasks: vi.fn(async () => [
			{
				id: "root",
				kind: "coordinator" as const,
				parentTaskId: null,
				status: "running",
				phase: "read",
				reportState: "none",
				acquisitionMode: null,
			},
			{
				id: "child",
				kind: "worker" as const,
				parentTaskId: "root",
				status: "running",
				phase: "search",
				reportState: "none",
				acquisitionMode: "rediscover" as const,
			},
		]),
		toolchainSelections: vi.fn(async () => ({ items: [], nextCursor: null })),
		agentReport: vi.fn(),
	} as unknown as EumenesClient;
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	try {
		render(
			<QueryClientProvider client={cache}>
				<ResearchTaskCard client={client} rootRunId="run" title="鎌倉の天気" />
			</QueryClientProvider>,
		);
		await screen.findByText("取得先を探し直し中");
		expect(screen.queryByText("検索して確認")).toBeNull();
	} finally {
		cache.clear();
	}
});

for (const [status, label] of [
	["cancelled", "停止"],
	["interrupted", "中断"],
	["failed", "調査未完了"],
])
	test(`${status} overrides the last active phase and removes stop control`, async () => {
		const client = {
			identity: `terminal-${status}`,
			agentTasks: vi.fn(async () => [
				{ ...root, status, phase: "read", reportState: "none" },
			]),
			toolchainSelections: vi.fn(async () => ({ items: [], nextCursor: null })),
			agentReport: vi.fn(),
		} as unknown as EumenesClient;
		const cache = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		try {
			render(
				<QueryClientProvider client={cache}>
					<ResearchTaskCard client={client} rootRunId="run" title="天気" />
				</QueryClientProvider>,
			);
			await screen.findByText(label!);
			expect(screen.queryByText("資料を確認中")).toBeNull();
			expect(screen.queryByRole("button", { name: "調査を停止" })).toBeNull();
		} finally {
			cache.clear();
		}
	});

test("progress can stop research and refresh the persisted terminal state", async () => {
	let status = "waiting_child";
	const client = {
		identity: "stop-activity",
		agentTasks: vi.fn(async () => [
			{ ...root, status, phase: "research", reportState: "none" },
			{
				...root,
				id: "worker",
				kind: "worker",
				status: "running",
				phase: "read",
				reportState: "none",
			},
		]),
		toolchainSelections: vi.fn(async () => ({ items: [], nextCursor: null })),
		agentReport: vi.fn(),
		cancelAgentTask: vi.fn(async () => {
			status = "cancelled";
		}),
	} as unknown as EumenesClient;
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	try {
		render(
			<QueryClientProvider client={cache}>
				<ResearchTaskCard client={client} rootRunId="run" title="天気" />
			</QueryClientProvider>,
		);
		fireEvent.click(await screen.findByRole("button", { name: "調査を停止" }));
		await screen.findByText("停止");
		expect(client.cancelAgentTask).toHaveBeenCalledExactlyOnceWith("root");
		expect(screen.queryByRole("button", { name: "調査を停止" })).toBeNull();
	} finally {
		cache.clear();
	}
});
