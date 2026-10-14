import { useQueries } from "@tanstack/react-query";
import { useMemo, useRef, useSyncExternalStore } from "react";
import type { ArtifactDefinitionV1 } from "../../../../api/domains/capabilities/contracts";
import type { EumenesClient } from "../../../../client";
import type { ToolchainArtifactEntry } from "../../../../client/toolchain-actions";
import { queryRoots } from "../../queryKeys";
import type { RegisteredField } from "./documents";
import { draftStoreFor, type DraftView } from "./drafts";
import { artifactIdOf, entryLabel } from "./launcher";
import { navigationTargets } from "./navigation";

/** The documents an artifact shows fields of or applies drafts of. */
export function documentsOf(artifact: ArtifactDefinitionV1): string[] {
	const docs = new Set<string>();
	for (const field of artifact.fields ?? []) docs.add(field.document);
	for (const action of artifact.actionBindings)
		if (action.draftDocument) docs.add(action.draftDocument);
	return [...docs];
}

/**
 * Fields of each document across the registered screens this one relates to: the other screens
 * of its adapter (field ids are unique over all registrations, so a review screen can describe
 * a field another screen registered) and the screens its navigate bindings open (a hub shows
 * whether their drafts are pending). `documents` is every document whose draft this screen
 * must follow; `ready` is false while any of those screens is still loading.
 */
export function useDocumentFields(
	client: EumenesClient,
	artifact: ArtifactDefinitionV1,
	artifactRevisionId: string,
	catalog: ReadonlyArray<ToolchainArtifactEntry>,
) {
	const adapterRef = artifact.sourceBindings[0]?.adapterRef;
	const ownDocuments = documentsOf(artifact);
	const targetIds = new Set(
		artifact.actionBindings.flatMap((b) =>
			navigationTargets(b).map((t) => t.artifactId),
		),
	);
	const others = catalog.filter(
		(e) =>
			e.artifactRevisionId !== artifactRevisionId &&
			((ownDocuments.length > 0 && e.adapterRef === adapterRef) ||
				targetIds.has(artifactIdOf(e.artifactRevisionId))),
	);
	const loaded = useQueries({
		queries: others.map((entry) => ({
			queryKey: [
				queryRoots.toolchainArtifacts,
				client.identity,
				"artifact",
				entry.artifactRevisionId,
			],
			queryFn: ({ signal }: { signal: AbortSignal }) =>
				client.toolchainArtifact(entry.artifactRevisionId, signal),
			staleTime: Number.POSITIVE_INFINITY,
		})),
	});
	const own = catalog.find((e) => e.artifactRevisionId === artifactRevisionId);
	const fields: Record<string, RegisteredField[]> = {};
	const documents = new Set(ownDocuments);
	const add = (
		definition: ArtifactDefinitionV1,
		section: string,
		revisionId: string,
	) => {
		const sources = definition.sourceBindings.map((s) => ({
			source: s.source,
			query: s.query,
		}));
		for (const field of definition.fields ?? []) {
			(fields[field.document] ??= []).push({
				...field,
				section,
				artifactRevisionId: revisionId,
				sources,
			});
			documents.add(field.document);
		}
		for (const doc of documentsOf(definition)) documents.add(doc);
	};
	add(artifact, own ? entryLabel(own) : artifact.title, artifactRevisionId);
	loaded.forEach((query, index) => {
		const entry = others[index];
		if (query.data && entry)
			add(query.data.artifact, entryLabel(entry), entry.artifactRevisionId);
	});
	return {
		fields,
		documents: [...documents],
		ready: loaded.every((query) => query.isSuccess || query.isError),
	};
}

/** One subscription over the shared drafts of the given documents. */
export function useDraftViews(
	identity: string,
	documents: readonly string[],
): Record<string, DraftView> {
	const key = documents.join("|");
	const cache = useRef<{
		key: string;
		views: DraftView[];
		value: Record<string, DraftView>;
	}>({
		key: "",
		views: [],
		value: {},
	});
	const stores = useMemo(
		() => documents.map((doc) => draftStoreFor(identity, doc)),
		// oxlint-disable-next-line react/exhaustive-deps
		[identity, key],
	);
	return useSyncExternalStore(
		(notify) => {
			const off = stores.map((store) => store.subscribe(notify));
			return () => {
				for (const fn of off) fn();
			};
		},
		() => {
			const views = stores.map((store) => store.getView());
			const last = cache.current;
			if (
				last.key === key &&
				views.length === last.views.length &&
				views.every((v, i) => v === last.views[i])
			)
				return last.value;
			const value = Object.fromEntries(
				documents.map((doc, i) => [doc, views[i]!] as const),
			);
			cache.current = { key, views, value };
			return value;
		},
	);
}
