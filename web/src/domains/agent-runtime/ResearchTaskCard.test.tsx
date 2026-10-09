import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
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
test("deleted reports disappear even when a previous response remains in the query cache", async () => {
	let current = root;
	const client = {
		identity: "card",
		agentTasks: vi.fn(async () => [current]),
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
test("a completed failure notice is displayed as retrieval failure, not research success", async () => {
	const client = {
		identity: "failed-card",
		agentTasks: vi.fn(async () => [
			{ ...root, reportState: "none", errorCode: "invalid_evidence" },
		]),
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
		await screen.findByText("取得失敗");
		expect(screen.queryByText("完了")).toBeNull();
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
