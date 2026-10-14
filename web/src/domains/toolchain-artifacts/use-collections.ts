import type { CollectionResource } from "@eumenes/artifact-ui";
import {
	keepPreviousData,
	useQueries,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { ArtifactDefinitionV1 } from "../../../../api/domains/capabilities/contracts";
import type { EumenesClient } from "../../../../client";
import { queryRoots } from "../../queryKeys";
import {
	collectionResource,
	defaultPaging,
	getPath,
	pagingParams,
	rowsOf,
	type FormOptions,
	type PagingQuery,
} from "./collections";

/** How often a list is re-read while one of its rows is in a state the registration watches. */
export const REFRESH_MS = 3000;

/**
 * The registered collections of an artifact: each source is read (with the table query as
 * `params` when it pages), and its resource is built from the registration and the data.
 * Paging, sorting and search are further reads of the same source.
 */
export function useCollections(
	client: EumenesClient,
	artifact: ArtifactDefinitionV1,
	artifactRevisionId: string,
) {
	const cache = useQueryClient();
	const collections = artifact.collections ?? [];
	const [queries, setQueries] = useState<Record<string, PagingQuery>>({});
	const [messages, setMessages] = useState<Record<string, string>>({});
	const queryOf = (source: string) => queries[source] ?? defaultPaging;
	const reads = useQueries({
		queries: collections.map((collection) => ({
			queryKey: [
				queryRoots.toolchainArtifacts,
				client.identity,
				"collection",
				artifactRevisionId,
				collection.source,
				collection.paging ? queryOf(collection.source) : null,
			],
			queryFn: async ({ signal }: { signal: AbortSignal }) =>
				(
					await client.toolchainArtifactSource(
						artifactRevisionId,
						collection.source,
						undefined,
						signal,
						collection.paging
							? pagingParams(queryOf(collection.source))
							: undefined,
					)
				).data,
			retry: false,
			placeholderData: keepPreviousData,
			// Only while a row is in a registered state (a running test): no other polling.
			refetchInterval: (query: { state: { data: unknown } }) => {
				const watch = collection.refreshWhile;
				return watch &&
					rowsOf(collection, query.state.data).some((row) =>
						watch.in.includes(getPath(row, watch.key) as never),
					)
					? REFRESH_MS
					: false;
			},
		})),
	});
	// Choices of form fields that name an `optionsSource`: the source of this artifact whose
	// binding query matches, read for its `data.options`.
	const optionQueries = [
		...new Set(
			collections.flatMap((c) =>
				[
					...(c.create?.fields ?? []),
					...c.rowActions.flatMap((a) => a.form?.fields ?? []),
				].flatMap((f) => (f.optionsSource ? [f.optionsSource] : [])),
			),
		),
	].flatMap((query) => {
		const source = artifact.sourceBindings.find((s) => s.query === query);
		return source ? [{ query, source: source.source }] : [];
	});
	const optionReads = useQueries({
		queries: optionQueries.map(({ source }) => ({
			queryKey: [
				queryRoots.toolchainArtifacts,
				client.identity,
				"form-options",
				artifactRevisionId,
				source,
			],
			queryFn: async ({ signal }: { signal: AbortSignal }) =>
				(
					await client.toolchainArtifactSource(
						artifactRevisionId,
						source,
						undefined,
						signal,
					)
				).data,
			retry: false,
		})),
	});
	const formOptions: Map<
		string,
		Array<{ value: string; label: string }>
	> = new Map();
	optionQueries.forEach(({ query }, index) => {
		const options = (
			optionReads[index]?.data as { options?: unknown } | undefined
		)?.options;
		if (Array.isArray(options))
			formOptions.set(
				query,
				options.flatMap((o) =>
					o &&
					typeof o === "object" &&
					typeof (o as { value: unknown }).value === "string" &&
					typeof (o as { label: unknown }).label === "string"
						? [o as { value: string; label: string }]
						: [],
				),
			);
	});
	const resources: Record<string, CollectionResource> = {};
	const data: Record<string, unknown> = {};
	collections.forEach((collection, index) => {
		const read = reads[index]!;
		data[collection.source] = read.data;
		resources[collection.source] = collectionResource({
			collection,
			data: read.data,
			bindings: artifact.actionBindings,
			// A new read always has a later time; stale events are refused by this number.
			revision: read.dataUpdatedAt,
			query: queryOf(collection.source),
			busy: read.isFetching,
			error: read.isError
				? "一覧を読み込めません。画面を更新して再試行してください。"
				: undefined,
			message: messages[collection.source],
			formOptions,
		});
	});
	const reload = useCallback(
		() =>
			void cache.invalidateQueries({
				queryKey: [
					queryRoots.toolchainArtifacts,
					client.identity,
					"collection",
					artifactRevisionId,
				],
			}),
		[cache, client.identity, artifactRevisionId],
	);
	return {
		collections,
		formOptions: formOptions as FormOptions,
		resources,
		data,
		reload,
		page: (source: string, query: PagingQuery) =>
			setQueries((old) => ({ ...old, [source]: query })),
		say: (source: string, message: string) =>
			setMessages((old) => ({ ...old, [source]: message })),
	};
}
export type Collections = ReturnType<typeof useCollections>;
