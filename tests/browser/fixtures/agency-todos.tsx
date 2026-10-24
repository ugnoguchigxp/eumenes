import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToolchainArtifactHost } from "../../../web/src/domains/toolchain-artifacts/ToolchainArtifactHost";
import { createWebAdapterRegistry } from "../../../web/src/domains/toolchain-artifacts/registry";
import { todosWebAdapter } from "../../../web/src/domains/agent-runtime/toolchain-adapter";
import { ResizableWorkspace } from "../../../web/src/components/domains/artifact/ResizableWorkspace";
import { ArtifactPanel } from "../../../web/src/components/domains/artifact/ArtifactPanel";
import { createClient } from "../../../client";

const client = createClient(window.location.origin);
const adapters = createWebAdapterRegistry([todosWebAdapter]);
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider
		client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
	>
		<ResizableWorkspace
			artifact={
				<ArtifactPanel
					tabs={[
						{
							id: "agency-todos",
							kind: "toolchain",
							title: "TODOリスト",
							artifactRevisionId: "artifact:agency.todos@1",
						},
					]}
					activeTabId="agency-todos"
					onSelect={() => {}}
					onClose={() => {}}
					renderToolchain={(tab, visible) => (
						<ToolchainArtifactHost
							client={client}
							adapters={adapters}
							artifactRevisionId={tab.artifactRevisionId}
							artifactId={tab.id}
							visible={visible}
						/>
					)}
				/>
			}
		>
			<section className="chat-panel" aria-label="会話">
				<h1>会話</h1>
				<p>表示確認用の会話エリア</p>
				<div className="fixture-composer">メッセージを入力</div>
			</section>
		</ResizableWorkspace>
	</QueryClientProvider>,
);
