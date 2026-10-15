import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createClient } from "../../client";
import { ToolchainArtifactHost } from "../src/domains/toolchain-artifacts/ToolchainArtifactHost";
import { createWebAdapterRegistry } from "../src/domains/toolchain-artifacts/registry";
import { settingsWebAdapter } from "../src/domains/settings-data/adapter";
import "@eumenes/design-system/styles";
import "@eumenes/artifact-ui/styles";
const client = createClient(window.location.origin);
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={new QueryClient()}>
		<ToolchainArtifactHost
			client={client}
			artifactId="workers-ai-browser"
			artifactRevisionId="artifact:settings.ai-connections@7"
			adapters={createWebAdapterRegistry([settingsWebAdapter])}
		/>
	</QueryClientProvider>,
);
