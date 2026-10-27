import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToolchainArtifactHost } from "../../../web/src/domains/toolchain-artifacts/ToolchainArtifactHost";
import { createWebAdapterRegistry } from "../../../web/src/domains/toolchain-artifacts/registry";
import { doclingWebAdapter } from "../../../web/src/domains/docling/toolchain-adapter";
import { createClient } from "../../../client";

createRoot(document.getElementById("root")!).render(
	<QueryClientProvider
		client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
	>
		<main aria-label="文章ナレッジベース管理アーティファクト">
			<h1>文章ナレッジベース管理</h1>
			<ToolchainArtifactHost
				client={createClient(window.location.origin)}
				adapters={createWebAdapterRegistry([doclingWebAdapter])}
				artifactRevisionId="artifact:docling.workspace@2"
				artifactId="docling.workspace"
				visible
			/>
		</main>
	</QueryClientProvider>,
);
