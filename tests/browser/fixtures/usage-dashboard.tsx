import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToolchainArtifactHost } from "../../../web/src/domains/toolchain-artifacts/ToolchainArtifactHost";
import { createWebAdapterRegistry } from "../../../web/src/domains/toolchain-artifacts/registry";
import { usageWebAdapter } from "../../../web/src/domains/usage/toolchain-adapter";
import type { EumenesClient } from "../../../client";
import type { UsageDashboardResource } from "@eumenes/artifact-ui/contracts";
import type { ArtifactDefinitionV1 } from "../../../api/domains/capabilities/contracts";
import bundle from "../../../api/domains/capabilities/bundles/usage-dashboard.bundle.json";
import "@eumenes/design-system/styles";
import "@eumenes/artifact-ui/styles";

const artifact = bundle.artifacts[0] as ArtifactDefinitionV1;
const revision = "artifact:usage.dashboard@1";
const localDay = (n: number) =>
	new Date(n + 9 * 3600000).toISOString().slice(0, 10);
const today = localDay(Date.now());
const summary = {
	count: 108,
	liveCount: 2,
	codexCount: 106,
	seconds: 2538,
	inputTokens: 120000,
	outputTokens: 8400,
	cacheReadTokens: 72000,
	cacheCreationTokens: 0,
	reasoningTokens: 1200,
	estimate: "1.269000000000",
	reportedUsd: null,
	unconfirmed: 1,
	missing: 1,
	cacheMissing: 1,
	unpriced: 1,
	active: 0,
};
let rateRevision = 0;
const rates: UsageDashboardResource["rates"] = [];
let sourceReads = 0;
const client = {
	identity: "usage-browser-fixture",
	toolchainArtifacts: async () => [
		{
			artifactRevisionId: revision,
			artifactId: "usage.dashboard",
			title: "利用状況",
			launcher: artifact.launcher,
			adapterRef: "adapter:usage@1",
		},
	],
	toolchainArtifact: async () => ({
		artifact,
		artifactRevisionId: revision,
		digest: "fixture",
		scopeRef: "scope:main",
	}),
	toolchainInteractions: async () => [],
	toolchainArtifactSource: async (
		_revision: string,
		_source: string,
		_target: unknown,
		_signal: unknown,
		params?: UsageDashboardResource["query"],
	) => {
		sourceReads++;
		const query = params ?? {
			start: today.slice(0, 8) + "01",
			end: today,
			service: "all",
			model: "",
			connectionId: "",
			pageIndex: 0,
		};
		const data: UsageDashboardResource = {
			kind: "usage-dashboard",
			revision: rateRevision,
			asOf: new Date().toISOString(),
			timezone: "Asia/Tokyo",
			query,
			summary:
				query.model === "model-other"
					? { ...summary, inputTokens: 999, outputTokens: 1, codexCount: 1 }
					: summary,
			daily: Array.from({ length: 7 }, (_, i) => ({
				...summary,
				date: localDay(Date.now() - (6 - i) * 86400000),
				seconds: (i + 1) * 80,
				estimate: String((i + 1) / 100),
			})),
			groups: [
				{
					...summary,
					service: "live",
					model: "voice-fixture",
					connectionName: "Voice",
					role: null,
				},
				{
					...summary,
					service: "codex",
					model: query.model || "model-current",
					connectionName: "SDK",
					role: "subagent",
				},
			],
			rows: Array.from({ length: 25 }, (_, i) => ({
				id: String(i + query.pageIndex * 25),
				service: "codex",
				model: query.model || "model-current",
				requestedModel: "model-current",
				connectionName: "SDK",
				connectionId: "sdk",
				started: new Date().toISOString(),
				ended: new Date().toISOString(),
				status: "succeeded",
				role: "subagent",
				seconds: null,
				inputTokens: 1000,
				outputTokens: 100,
				cacheReadTokens: 400,
				cacheCreationTokens: 0,
				reasoningTokens: 10,
				confirmed: true,
				test: false,
				estimate: null,
				rateId: null,
				reportedUsd: null,
			})),
			total: 108,
			pageSize: 25,
			rates,
			models: ["voice-fixture", "model-current", "model-other"],
			liveModels: ["voice-fixture"],
			currentCodexModel: "model-current",
			connections: [{ id: "sdk", name: "SDK" }],
		};
		document.documentElement.dataset.reads = String(sourceReads);
		document.documentElement.dataset.queryModel = query.model;
		return { revision: rateRevision, data };
	},
	submitToolchainAction: async (event: {
		eventId: string;
		input: Record<string, string>;
	}) => {
		rateRevision++;
		rates.unshift({
			id: String(rateRevision),
			...event.input,
			checkedAt: new Date().toISOString(),
		} as UsageDashboardResource["rates"][number]);
		document.documentElement.dataset.writes = String(rateRevision);
		return {
			httpStatus: 200,
			view: {
				eventId: event.eventId,
				status: "accepted",
				createdAt: new Date().toISOString(),
				result: {
					version: 1,
					executionId: "fixture",
					artifactRevisionId: revision,
					outcome: "completed",
					resultRefs: [],
					artifactRefs: [],
					receipt: { id: "save", revision: rateRevision },
				},
			},
		};
	},
} as unknown as EumenesClient;
const cache = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={cache}>
		<main
			style={{
				margin: "16px auto",
				maxWidth: 940,
				border: "1px solid var(--border)",
				borderRadius: 10,
				overflow: "hidden",
			}}
		>
			<ToolchainArtifactHost
				client={client}
				adapters={createWebAdapterRegistry([usageWebAdapter])}
				artifactId="usage-fixture"
				artifactRevisionId={revision}
				visible
			/>
		</main>
	</QueryClientProvider>,
);
