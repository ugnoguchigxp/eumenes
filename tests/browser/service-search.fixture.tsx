import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ResearchTaskCard } from "../../web/src/domains/agent-runtime/ResearchTaskCard";
import type { EumenesClient } from "../../client";

let completed = false;
const cache = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const client = {
	identity: "service-search-fixture",
	agentTasks: async () => [
		{
			id: "root",
			kind: "coordinator",
			rootRunId: "run",
			status: completed ? "completed" : "waiting_child",
			phase: "research",
			reportState: completed ? "available" : "none",
			errorCode: null,
		},
		{
			id: "worker",
			kind: "worker",
			rootRunId: "run",
			status: completed ? "completed" : "running",
			phase: "search",
			reportState: "none",
		},
	],
	toolchainSelections: async () => ({
		items: [{ decision: "toolchain", functionName: "service_search" }],
		nextCursor: null,
	}),
	agentReport: async () => ({
		version: 2,
		outcome: "candidates_found",
		summary: "サイト内検索がログイン待ちのため、外部検索で補いました。",
		claims: [],
		limitations: ["本文未確認"],
		coverage: "partial",
		sources: [],
		candidateResults: [
			{
				reference: "c1",
				sourceId: "s1",
				url: "https://example.org/video",
				title: "Python3入門動画",
				fetchedAt: new Date(0).toISOString(),
				provider: "duckduckgo",
				contentStatus: "unverified",
			},
		],
	}),
} as unknown as EumenesClient;
Object.assign(window, {
	serviceSearchFixture: {
		complete: async () => {
			completed = true;
			await cache.invalidateQueries();
		},
	},
});
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={cache}>
		<ResearchTaskCard client={client} rootRunId="run" title="サービス内検索" />
	</QueryClientProvider>,
);
