import { useQueries } from "@tanstack/react-query";
import type { Settings } from "../../../../api/domains/settings/contracts";
import type { EumenesClient } from "../../../../client";
import { queryRoots } from "../../queryKeys";
import type { RegisteredField } from "../toolchain-artifacts/documents";

/** The cloud TTS models the settings document can be adjusted for, read from their source. */
export function useTtsTargets(
	client: EumenesClient,
	all: ReadonlyArray<RegisteredField>,
	saved: Settings | undefined,
) {
	// The cloud models a field can be applied to come from the source of the screen that
	// registered it, so the review screen names them the same way.
	const targetSources = [
		...new Map(
			all
				.filter((f) => f.target)
				.map((f) => [
					`${f.artifactRevisionId}|${f.target}`,
					{ revision: f.artifactRevisionId, source: f.target! },
				]),
		).values(),
	];
	const targetReads = useQueries({
		queries: targetSources.map(({ revision, source }) => ({
			queryKey: [
				queryRoots.toolchainArtifacts,
				client.identity,
				"targets",
				revision,
				source,
				saved?.revision ?? 0,
			],
			queryFn: ({ signal }: { signal: AbortSignal }) =>
				client.toolchainArtifactSource(revision, source, undefined, signal),
			staleTime: 60_000,
			retry: false,
		})),
	});
	const targetData = targetReads
		.map((read) => read.data?.data)
		.find((data) => !!data && typeof data === "object" && "targets" in data) as
		| {
				localAvailable?: boolean;
				targets: Array<{ id: string; label: string; selectLabel?: string }>;
		  }
		| undefined;
	// `label` names a target inside field labels and review rows; `selectLabel` (with the
	// assignment state) labels it in the target chooser.
	const targets = (targetData?.targets ?? []).map(({ id, label }) => ({
		id,
		label,
	}));
	return { targetData, targets };
}

/** Choices that come from an adapter query, by the query's id. */
export function useFieldOptions(
	client: EumenesClient,
	all: ReadonlyArray<RegisteredField>,
) {
	// Choices that come from an adapter query rather than from the registration are read where
	// the field was registered, so a review screen labels values the way its owner does.
	const optionFields = all.filter(
		(f) =>
			f.optionsSource &&
			f.sources.some((source) => source.query === f.optionsSource),
	);
	const optionSources = [
		...new Map(
			optionFields.map((f) => {
				const source = f.sources.find((s) => s.query === f.optionsSource)!;
				return [
					`${f.artifactRevisionId}|${source.source}`,
					{
						revision: f.artifactRevisionId,
						source: source.source,
						query: f.optionsSource!,
					},
				] as const;
			}),
		).values(),
	];
	const fetched = useQueries({
		queries: optionSources.map(({ revision, source }) => ({
			queryKey: [
				queryRoots.toolchainArtifacts,
				client.identity,
				"options",
				revision,
				source,
			],
			queryFn: ({ signal }: { signal: AbortSignal }) =>
				client.toolchainArtifactSource(revision, source, undefined, signal),
			staleTime: 60_000,
			retry: false,
		})),
	});
	const fetchedOptions = new Map<string, { value: string; label: string }[]>();
	optionSources.forEach(({ query: ref }, index) => {
		const data = fetched[index]?.data?.data;
		const list = Array.isArray(data)
			? data
			: data && typeof data === "object" && "options" in data
				? (data as { options: unknown }).options
				: [];
		if (Array.isArray(list))
			fetchedOptions.set(
				ref,
				list.flatMap((o) =>
					o &&
					typeof o === "object" &&
					typeof (o as { value: unknown }).value === "string" &&
					typeof (o as { label: unknown }).label === "string"
						? [
								{
									value: (o as { value: string }).value,
									label: (o as { label: string }).label,
								},
							]
						: [],
				),
			);
	});
	return fetchedOptions;
}
