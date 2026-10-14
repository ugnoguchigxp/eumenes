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

/** `artifact:settings.display@2` -> `settings.display` (the id a navigate binding names). */
export function artifactIdOf(artifactRevisionId: string) {
	return /^artifact:(.+)@[0-9]+$/.exec(artifactRevisionId)?.[1] ?? "";
}

/** The name an entry shows in the launcher and on its tab. */
export function entryLabel(
	entry: Pick<ToolchainArtifactEntry, "title" | "launcher">,
) {
	return entry.launcher?.label ?? entry.title;
}

/**
 * The top-level launcher entries. A standalone artifact with a `launcher.group` is reached
 * through its hub instead, so the menu stays one entry per feature.
 */
export function menuEntries(entries: readonly ToolchainArtifactEntry[]) {
	return entries
		.filter((entry) => !entry.launcher?.group)
		.sort((a, b) => (a.launcher?.order ?? 500) - (b.launcher?.order ?? 500));
}

export function useToolchainArtifacts(
	client: EumenesClient,
	open: (tab: ArtifactTab) => void,
) {
	const cache = useQueryClient();
	const list = useQuery(toolchainArtifactsQuery(client));
	const openEntry = useCallback(
		(
			entry: Pick<
				ToolchainArtifactEntry,
				"artifactRevisionId" | "title" | "launcher"
			>,
			targetRef?: string,
			variant = true,
		) => {
			const variantId = variant ? artifactVariantFromUrl() : undefined;
			open({
				id: toolchainTabId(entry.artifactRevisionId),
				kind: "toolchain",
				title: entryLabel(entry),
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
	/** A navigate binding: open the registered artifact with this id (no variant override). */
	const openById = useCallback(
		async (artifactId: string) => {
			const entries = await cache
				.fetchQuery(toolchainArtifactsQuery(client))
				.catch(() => []);
			const entry = entries.find(
				(e) => artifactIdOf(e.artifactRevisionId) === artifactId,
			);
			if (!entry) return false;
			openEntry(entry, undefined, false);
			return true;
		},
		[cache, client, openEntry],
	);
	return { entries: list.data ?? [], openEntry, openByAdapter, openById };
}
