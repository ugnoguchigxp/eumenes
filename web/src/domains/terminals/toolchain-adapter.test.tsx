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
