import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useArtifactWorkspace } from "../domains/artifact";
import { useToolchainArtifacts } from "../domains/toolchain-artifacts/launcher";
import { createClient } from "../../../client";
afterEach(cleanup);
const revision = "artifact:agency.todos@2";
const makeClient = () => ({
	...createClient("http://127.0.0.1:4444"),
	toolchainArtifacts: vi.fn(async () => [
		{
			artifactRevisionId: revision,
			title: "TODOリスト",
			adapterRef: "adapter:task-execution@1",
			launcher: { label: "TODOリスト", order: 15 },
		},
	]),
});
test("registered launcher opens one common artifact tab with no per-screen opener", async () => {
	const client = makeClient();
	const cache = new QueryClient();
	const view = renderHook(
		() => {
			const workspace = useArtifactWorkspace();
			const launcher = useToolchainArtifacts(client, workspace.open);
			return { workspace, launcher };
		},
		{
			wrapper: ({ children }) => (
				<QueryClientProvider client={cache}>{children}</QueryClientProvider>
			),
		},
	);
	await waitFor(() =>
		expect(view.result.current.launcher.entries).toHaveLength(1),
	);
	act(() => {
		view.result.current.launcher.openEntry(
			view.result.current.launcher.entries[0]!,
		);
		view.result.current.launcher.openEntry(
			view.result.current.launcher.entries[0]!,
		);
	});
	expect(view.result.current.workspace.tabs).toHaveLength(1);
	expect(view.result.current.workspace.tabs[0]).toMatchObject({
		kind: "toolchain",
		title: "TODOリスト",
		artifactRevisionId: revision,
	});
});
