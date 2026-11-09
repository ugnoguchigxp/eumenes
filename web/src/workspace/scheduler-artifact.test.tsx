import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import bundle from "../../../api/domains/capabilities/bundles/scheduler.bundle.json";
import { artifactDefinitionV1 } from "../../../api/domains/capabilities/contracts";
import { createClient } from "../../../client";
import type { ChangeKind } from "../../../client/events";
import { ToolchainArtifactHost } from "../domains/toolchain-artifacts/ToolchainArtifactHost";
import { createWebAdapterRegistry } from "../domains/toolchain-artifacts/registry";
import { schedulerWebAdapter } from "../domains/scheduler/toolchain-adapter";

afterEach(cleanup);

test("an open reservation artifact updates from empty on a committed change", async () => {
	const artifact = artifactDefinitionV1.parse(bundle.artifacts[0]);
	const artifactRevisionId = "artifact:scheduler.pending@1";
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
	await screen.findByText("項目はありません。");
	items.push({
		id: "schedule-1",
		title: "明日の準備",
		kind: "会話",
		interval: "一回",
		status: "予約済み",
		nextDueAt: "2026-11-11T08:00:00+09:00",
	});
	act(() => {
		for (const listener of listeners) listener("change");
	});
	const row = within(await screen.findByRole("row", { name: /明日の準備/ }));
	expect(row.getByText("予約済み")).toBeTruthy();
	expect(row.getByText("一回")).toBeTruthy();
	unmount();
	expect(listeners.size).toBe(0);
});
