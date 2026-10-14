import { useQueries } from "@tanstack/react-query";
import type { Settings } from "../../../../api/domains/settings/contracts";
import type { EumenesClient } from "../../../../client";
import { queryRoots } from "../../queryKeys";
import type { RegisteredField } from "../toolchain-artifacts/documents";

const TTS_RESOURCES = "query:settings.tts-resources@1";
type TargetData = {
	localAvailable?: boolean;
	targets: Array<{ id: string; label: string; selectLabel?: string }>;
};

/**
 * The array elements (connections, models) per-target fields apply to, read from the target
 * source of the screen that registered each field, so a review screen names them the same way.
 * The cloud speech models also tell whether the local voice is available.
 */
export function useTargets(
	client: EumenesClient,
	all: ReadonlyArray<RegisteredField>,
	saved: Settings | undefined,
) {
	const targetSources = [
		...new Map(
			all
				.filter((f) => f.target)
				.map((f) => [
					`${f.artifactRevisionId}|${f.target}`,
					{
						revision: f.artifactRevisionId,
						source: f.target!,
						query: f.sources.find((s) => s.source === f.target)?.query,
					},
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
	const dataOf = (read: (typeof targetReads)[number]) => {
		const data = read.data?.data;
		return data && typeof data === "object" && "targets" in data
			? (data as TargetData)
			: undefined;
	};
	const bySource = new Map<string, TargetData>();
	targetSources.forEach((source, index) => {
		const data = dataOf(targetReads[index]!);
		if (data) bySource.set(`${source.revision}|${source.source}`, data);
	});
	const speechIndex = targetSources.findIndex((s) => s.query === TTS_RESOURCES);
	const targetData =
		speechIndex < 0 ? undefined : dataOf(targetReads[speechIndex]!);
	return {
		/** The targets of a field, labelled for field names and review rows. */
		targetsOf: (field: RegisteredField) =>
			(
				bySource.get(`${field.artifactRevisionId}|${field.target}`)?.targets ??
				[]
			).map(({ id, label }) => ({ id, label })),
		/** The cloud speech models, with the chooser labels (`selectLabel`). */
		targetData,
	};
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
