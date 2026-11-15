import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ArtifactPanel } from "../../web/src/components/domains/artifact/ArtifactPanel";
import { ResizableWorkspace } from "../../web/src/components/domains/artifact/ResizableWorkspace";
import { createClient } from "../../client";
import { ToolchainArtifactHost } from "../../web/src/domains/toolchain-artifacts/ToolchainArtifactHost";
import { createWebAdapterRegistry } from "../../web/src/domains/toolchain-artifacts/registry";
import { videoWebAdapter } from "../../web/src/domains/video/toolchain-adapter";
import videoBundle from "../../api/domains/capabilities/bundles/video.bundle.json";
import "@eumenes/design-system/styles";
import "@eumenes/artifact-ui/styles";
import "../../web/src/app.css";

const artifactRevisionId = "artifact:video.workspace@2";
const api = createClient(location.origin, "eumenes-browser-fixture");
const client = {
	...api,
	toolchainArtifact: async () => ({
		artifact: videoBundle.artifacts[1]!,
		artifactRevisionId,
		scopeRef: "scope:main",
	}),
	unsettledToolchainActions: async () => [],
} as unknown as typeof api;
const cache = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={cache}>
		<main className="app-shell">
			<ResizableWorkspace
				artifact={
					<ArtifactPanel
						tabs={[
							{
								id: "video",
								kind: "toolchain",
								title: "動画生成",
								artifactRevisionId,
							},
						]}
						activeTabId="video"
						onSelect={() => {}}
						onClose={() => {}}
						renderToolchain={(_, visible) => (
							<ToolchainArtifactHost
								client={client}
								adapters={createWebAdapterRegistry([videoWebAdapter])}
								artifactRevisionId={artifactRevisionId}
								artifactId="video"
								visible={visible}
							/>
						)}
					/>
				}
			>
				<section className="chat-panel" aria-label="会話">
					<p>前に作った動画を見せて</p>
				</section>
			</ResizableWorkspace>
		</main>
	</QueryClientProvider>,
);
