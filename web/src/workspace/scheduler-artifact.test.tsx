import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import bundle from "../../../api/domains/capabilities/bundles/scheduler.bundle.json";
import { artifactDefinitionV1 } from "../../../api/domains/capabilities/contracts";
import { createClient } from "../../../client";
import type { ChangeKind } from "../../../client/events";
import { ToolchainArtifactHost } from "../domains/toolchain-artifacts/ToolchainArtifactHost";
import { createWebAdapterRegistry } from "../domains/toolchain-artifacts/registry";
import { schedulerWebAdapter } from "../domains/scheduler/toolchain-adapter";

afterEach(cleanup);

test("the agenda updates from empty and distinguishes single, recurring and paused reservations", async () => {
	const artifact = artifactDefinitionV1.parse(
		bundle.artifacts.find((item) => item.revision === 2),
	);
	const artifactRevisionId = "artifact:scheduler.pending@2";
	const items: Record<string, unknown>[] = [];
	const listeners = new Set<(kind: ChangeKind) => void>();
	const client = {
		...createClient("http://127.0.0.1:4444"),
		toolchainArtifact: vi.fn(async () => ({
			artifact,
			artifactRevisionId,
			digest: "fixture",
			scopeRef: "scope:fixture",
		})),
		toolchainArtifacts: vi.fn(async () => []),
		unsettledToolchainActions: vi.fn(async () => []),
		toolchainArtifactSource: vi.fn(async () => ({
			revision: 0,
			data: { items: [...items] },
		})),
		subscribeChanges: (listener: (kind: ChangeKind) => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	const { unmount } = render(
		<QueryClientProvider client={cache}>
			<ToolchainArtifactHost
				client={client}
				adapters={createWebAdapterRegistry([schedulerWebAdapter])}
				artifactRevisionId={artifactRevisionId}
				artifactId="scheduler-1"
				visible
			/>
		</QueryClientProvider>,
	);
	await screen.findByText("予約はまだありません");
	items.push(
		{
			id: "later",
			title: "開発日誌",
			kind: "ワークフロー",
			interval: "1日ごと",
			intervalMs: 86_400_000,
			state: "active",
			nextDueAt: "2026-11-11T09:00:00+09:00",
		},
		{
			id: "next",
			title: "明日の準備",
			kind: "会話",
			interval: "一回",
			intervalMs: null,
			state: "active",
			nextDueAt: "2026-11-10T15:30:00Z",
		},
		{
			id: "paused",
			title: "週次メモ",
			kind: "会話",
			interval: "7日ごと",
			intervalMs: 604_800_000,
			state: "paused",
			nextDueAt: null,
		},
	);
	act(() => {
		for (const listener of listeners) listener("change");
	});
	const featured = within(
		await screen.findByRole("region", { name: "次の実行" }),
	);
	expect(featured.getByRole("heading", { name: "明日の準備" })).toBeTruthy();
	expect(featured.getByText("00:30")).toBeTruthy();
	expect(featured.getByTitle("一度きり").querySelector("svg")).toBeTruthy();
	expect(screen.getAllByRole("heading", { name: /11月11日/ })).toHaveLength(1);
	const list = within(screen.getByRole("region", { name: "予約一覧" }));
	expect(
		list.getAllByTitle("繰り返し").map((entry) => entry.textContent),
	).toEqual(["1日ごと", "7日ごと"]);
	expect(
		[
			...screen
				.getByRole("region", { name: "予約一覧" })
				.querySelectorAll(".aui-agenda-row > .aui-agenda-item > strong"),
		].map((label) => label.textContent),
	).toEqual(["明日の準備", "開発日誌", "週次メモ"]);
	fireEvent.click(screen.getByRole("button", { name: "繰り返し" }));
	expect(list.queryByText("明日の準備")).toBeNull();
	const preview = list.getByText("今後3回の予定");
	fireEvent.click(preview);
	const upcoming = preview.closest("details")!;
	expect(upcoming.hasAttribute("open")).toBe(true);
	expect(
		[...upcoming.querySelectorAll("time")].map((time) => time.dateTime),
	).toEqual([
		"2026-11-11T00:00:00.000Z",
		"2026-11-12T00:00:00.000Z",
		"2026-11-13T00:00:00.000Z",
	]);
	const paused = screen.getByRole("button", { name: "一時停止" });
	fireEvent.click(paused);
	expect(paused.getAttribute("aria-pressed")).toBe("true");
	expect(screen.getAllByRole("listitem")).toHaveLength(1);
	expect(screen.getByRole("listitem").textContent).toContain("週次メモ");
	expect(list.queryByText("今後3回の予定")).toBeNull();
	unmount();
	expect(listeners.size).toBe(0);
});
