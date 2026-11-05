import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import bundle from "../../../api/domains/capabilities/bundles/collaboration.bundle.json";
import { artifactDefinitionV1 } from "../../../api/domains/capabilities/contracts";
import { createClient } from "../../../client";
import { ToolchainArtifactHost } from "../domains/toolchain-artifacts/ToolchainArtifactHost";
import { createWebAdapterRegistry } from "../domains/toolchain-artifacts/registry";
import { collaborationWebAdapters } from "../domains/collaboration/toolchain-adapter";

afterEach(cleanup);
test.each(["pipeline", "interact"])(
	"registered %s artifact displays the current host state in the real renderer",
	async (kind) => {
		const artifact = artifactDefinitionV1.parse(
			bundle.artifacts.find((a) => a.id === `collaboration.${kind}`),
		);
		const client = {
			...createClient("http://127.0.0.1:4444"),
			toolchainArtifact: vi.fn(async () => ({
				artifact,
				artifactRevisionId: `artifact:collaboration.${kind}@1`,
				digest: "fixture",
				scopeRef: "scope:fixture",
			})),
			toolchainArtifacts: vi.fn(async () => []),
			unsettledToolchainActions: vi.fn(async () => []),
			toolchainArtifactSource: vi.fn(async () => ({
				revision: 3,
				data: {
					kind: "work-result",
					revision: 3,
					targetRef: "work-1",
					work: {
						title: "現在の作品",
						status: "確認待ち",
						request: "一緒に修正",
						summary: "利用者の確認を待っています。",
						sections: [{ title: "手順", items: ["<script>alert(1)</script>"] }],
					},
				},
			})),
		};
		const cache = new QueryClient({
			defaultOptions: { queries: { retry: false, gcTime: 0 } },
		});
		render(
			<QueryClientProvider client={cache}>
				<ToolchainArtifactHost
					client={client}
					adapters={createWebAdapterRegistry(collaborationWebAdapters)}
					artifactRevisionId={`artifact:collaboration.${kind}@1`}
					artifactId="collaboration-1"
					conversationId="main"
					visible
				/>
			</QueryClientProvider>,
		);
		await screen.findByText("利用者の確認を待っています。");
		fireEvent.click(screen.getByRole("tab", { name: "成果" }));
		expect(screen.getByText("<script>alert(1)</script>")).toBeTruthy();
		expect(document.querySelector("script")).toBeNull();
		expect(client.toolchainArtifactSource.mock.calls[0]).toEqual([
			`artifact:collaboration.${kind}@1`,
			"collaboration",
			undefined,
			expect.any(AbortSignal),
			{ conversationId: "main" },
		]);
	},
);
