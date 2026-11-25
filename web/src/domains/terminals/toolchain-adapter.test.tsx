import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { expect, test, vi } from "vitest";
import { ApiError, createClient } from "../../../../client";
import type { AdapterHostContext } from "../toolchain-artifacts/registry";
import { terminalsWebAdapter } from "./toolchain-adapter";

test("the terminal start action explains a workspace conflict", async () => {
	const binding = {
		actionId: "start",
		eventAction: "terminal-start",
		source: "terminals",
		inputSchemaRef: "builtin:emptyInput",
		effect: "local",
	} as const;
	const artifact: AdapterHostContext["artifact"] = {
		kind: "artifact",
		id: "terminals.workspace",
		revision: 2,
		title: "Claude Code",
		variants: [
			{
				id: "standard",
				label: "標準",
				definition: { view: "terminal-workspace", source: "terminals" },
			},
		],
		defaultVariant: "standard",
		sourceBindings: [
			{
				source: "terminals",
				adapterRef: "adapter:terminals@1",
				query: "query:terminals.sessions@1",
				target: "none",
			},
		],
		actionBindings: [binding],
	};
	const client = createClient("http://127.0.0.1:8787", "fixture-token");
	vi.spyOn(client, "toolchainArtifactSource").mockResolvedValue({
		revision: 0,
		data: { available: true, revision: 0, sessions: [], requests: 0, limit: 4 },
	});
	vi.spyOn(client, "startTerminal").mockRejectedValue(
		new ApiError(409, "terminal_workspace_busy"),
	);
	const cache = new QueryClient();
	const { result, unmount } = renderHook(
		() =>
			terminalsWebAdapter.useArtifact({
				client,
				artifact,
				artifactRevisionId: "artifact:terminals.workspace@2",
				targetRef: undefined,
				setTargetRef() {},
				visible: true,
				catalog: [],
				documentFields: {},
				documentFieldsReady: true,
				drafts: {},
				notify() {},
			}),
		{
			wrapper: ({ children }: PropsWithChildren) => (
				<QueryClientProvider client={cache}>{children}</QueryClientProvider>
			),
		},
	);
	try {
		await waitFor(() => expect(result.current.phase.kind).toBe("ready"));
		await act(async () => {
			expect(
				await result.current.local(binding, {
					id: "fixture-terminal-start",
					action: "terminal-start",
					source: binding.source,
					revision: 0,
					values: {},
				}),
			).toEqual({
				status: "rejected",
				message:
					"Claude Code の作業フォルダーが使用中です。空いてから開き直してください。",
			});
		});
	} finally {
		unmount();
		cache.clear();
	}
});

test("a work handed to Claude Code shows read-only and is what the screen watches instead of starting a terminal", async () => {
	const artifact: AdapterHostContext["artifact"] = {
		kind: "artifact",
		id: "terminals.workspace",
		revision: 2,
		title: "Claude Code",
		variants: [
			{
				id: "standard",
				label: "標準",
				definition: { view: "terminal-workspace", source: "terminals" },
			},
		],
		defaultVariant: "standard",
		sourceBindings: [
			{
				source: "terminals",
				adapterRef: "adapter:terminals@1",
				query: "query:terminals.sessions@1",
				target: "none",
			},
		],
		actionBindings: [],
	};
	const pane = (status: "running" | "exited") => ({
		id: "33333333-3333-4333-8333-333333333333",
		title: "背景色の実装",
		owner: "claude-task:33333333-3333-4333-8333-333333333333",
		mode: "work" as const,
		status,
		run: 1,
		startedAt: "2026-11-25T11:48:49.000Z",
		readOnly: true,
		...(status === "exited" ? { statusMessage: "完了" } : {}),
	});
	const client = createClient("http://127.0.0.1:8787", "fixture-token");
	const source = vi.spyOn(client, "toolchainArtifactSource");
	const render = () => {
		const cache = new QueryClient();
		const hook = renderHook(
			() =>
				terminalsWebAdapter.useArtifact({
					client,
					artifact,
					artifactRevisionId: "artifact:terminals.workspace@2",
					targetRef: undefined,
					setTargetRef() {},
					visible: true,
					catalog: [],
					documentFields: {},
					documentFieldsReady: true,
					drafts: {},
					notify() {},
				}),
			{
				wrapper: ({ children }: PropsWithChildren) => (
					<QueryClientProvider client={cache}>{children}</QueryClientProvider>
				),
			},
		);
		return { ...hook, cache };
	};
	const resource = (snapshot: Record<string, unknown>) =>
		snapshot.terminals as {
			startNeeded?: boolean;
			sessions: Array<Record<string, unknown>>;
		};

	source.mockResolvedValue({
		revision: 0,
		data: {
			available: true,
			revision: 0,
			sessions: [pane("running")],
			requests: 1,
			limit: 4,
		},
	});
	const running = render();
	try {
		await waitFor(() =>
			expect(running.result.current.phase.kind).toBe("ready"),
		);
		const shown = resource(running.result.current.snapshot);
		expect(shown.startNeeded).toBe(false);
		expect(shown.sessions[0]).toMatchObject({
			heading: "Claude Code（専任担当）",
			readOnly: true,
			status: "running",
		});
	} finally {
		running.unmount();
		running.cache.clear();
	}

	// Only finished works: opening the screen still starts a terminal, as before.
	source.mockResolvedValue({
		revision: 1,
		data: {
			available: true,
			revision: 1,
			sessions: [pane("exited")],
			requests: 1,
			limit: 4,
		},
	});
	const finished = render();
	try {
		await waitFor(() =>
			expect(finished.result.current.phase.kind).toBe("ready"),
		);
		const shown = resource(finished.result.current.snapshot);
		expect(shown.startNeeded).toBe(true);
		expect(shown.sessions[0]).toMatchObject({ statusMessage: "完了" });
	} finally {
		finished.unmount();
		finished.cache.clear();
	}
});
