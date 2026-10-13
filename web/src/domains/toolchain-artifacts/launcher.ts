import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { EumenesClient } from "../../../../client";
import type { ToolchainArtifactEntry } from "../../../../client/toolchain-actions";
import { queryRoots } from "../../queryKeys";
import type { ArtifactTab } from "../artifact";

export type ToolchainTab = Extract<ArtifactTab, { kind: "toolchain" }>;

/** The launcher list: one entry per registered artifact, never one per saved item. */
export function toolchainArtifactsQuery(client: EumenesClient) {
	return {
		queryKey: [queryRoots.toolchainArtifacts, client.identity, "list"] as const,
		queryFn: ({ signal }: { signal: AbortSignal }) =>
			client.toolchainArtifacts(signal),
		staleTime: 30_000,
	};
}

/** A tab id the backend accepts as an artifactId (`[A-Za-z0-9:_-]`). */
export function toolchainTabId(artifactRevisionId: string) {
	return `toolchain-${artifactRevisionId.replace(/[^A-Za-z0-9_-]+/g, "-")}`.slice(
		0,
		80,
	);
}

/** Acceptance and comparison runs pick a registered variant with `?artifactVariant=<id>`. */
export function artifactVariantFromUrl(
	search = window.location.search,
): string | undefined {
	return new URLSearchParams(search).get("artifactVariant") ?? undefined;
}

export function useToolchainArtifacts(
	client: EumenesClient,
	open: (tab: ArtifactTab) => void,
) {
	const cache = useQueryClient();
	const list = useQuery(toolchainArtifactsQuery(client));
	const openEntry = useCallback(
		(
			entry: Pick<ToolchainArtifactEntry, "artifactRevisionId" | "title">,
			targetRef?: string,
		) => {
			const variantId = artifactVariantFromUrl();
			open({
				id: toolchainTabId(entry.artifactRevisionId),
				kind: "toolchain",
				title: entry.title,
				artifactRevisionId: entry.artifactRevisionId,
				...(variantId ? { variantId } : {}),
				...(targetRef ? { targetRef } : {}),
			});
		},
		[open],
	);
	/** Opens the registered artifact of a domain's adapter (e.g. a result found in the chat). */
	const openByAdapter = useCallback(
		async (adapterRef: string, targetRef?: string) => {
			// A failed catalog read leaves the screen as it is; the launcher stays available.
			const entries = await cache
				.fetchQuery(toolchainArtifactsQuery(client))
				.catch(() => []);
			const entry = entries.find((e) => e.adapterRef === adapterRef);
			if (entry) openEntry(entry, targetRef);
		},
		[cache, client, openEntry],
	);
	return { entries: list.data ?? [], openEntry, openByAdapter };
}
