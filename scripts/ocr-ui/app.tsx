import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ArtifactRenderer } from "../../packages/artifact-ui/src";
import { useOcrRuntime } from "../../web/src/domains/ocr/use-ocr-runtime";
import { ocrClient } from "../../client/ocr";
import { createTransport } from "../../client/transport";
import type { EumenesClient } from "../../client";
import bundle from "../../api/domains/capabilities/bundles/ocr.bundle.json";
import "../../packages/design-system/src/styles/themes.css";
import "../../packages/design-system/dist/design-system.css";
import "../../packages/artifact-ui/src/styles.css";

const transport = createTransport(
	"http://127.0.0.1:19400",
	"fixture-token-for-toolchain-browser",
);
const client = {
	...ocrClient(transport),
	identity: transport.identity,
} as EumenesClient;
const definition = JSON.stringify(
	bundle.artifacts.at(-1)!.variants[0]!.definition,
);
function App() {
	const { runtime } = useOcrRuntime(client);
	return <ArtifactRenderer definition={definition} runtime={runtime} />;
}
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider
		client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
	>
		<App />
	</QueryClientProvider>,
);
