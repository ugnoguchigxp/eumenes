import {
	scheduleAgendaData,
	type ScheduleAgendaResource,
} from "@eumenes/artifact-ui/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { queryRoots } from "../../queryKeys";
import { genericWebAdapter } from "../toolchain-artifacts/generic-adapter";
import type { WebArtifactAdapter } from "../toolchain-artifacts/registry";
import { collectionQueryKey } from "../toolchain-artifacts/use-collections";

const agendaQueryKey = (identity: string, revisionId: string) =>
	[
		queryRoots.toolchainArtifacts,
		identity,
		"schedule-agenda",
		revisionId,
	] as const;

/** Registration and firing may happen while an empty list is already open. */
export const schedulerWebAdapter: WebArtifactAdapter = {
	adapterRef: "adapter:scheduler@1",
	useArtifact(context) {
		const { client, visible, artifact, artifactRevisionId } = context;
		const cache = useQueryClient();
		const source = artifact.sourceBindings.find(
			({ source }) => source === "agenda",
		)?.source;
		const agenda = useQuery({
			queryKey: agendaQueryKey(client.identity, artifactRevisionId),
			enabled: !!source && visible,
			retry: false,
			queryFn: async ({ signal }): Promise<ScheduleAgendaResource> => {
				const read = await client.toolchainArtifactSource(
					artifactRevisionId,
					source!,
					undefined,
					signal,
				);
				return {
					kind: "schedule-agenda",
					revision: read.revision,
					...scheduleAgendaData.parse(read.data),
				};
			},
		});
		useEffect(() => {
			if (!visible) return;
			const queryKey = source
				? agendaQueryKey(client.identity, artifactRevisionId)
				: collectionQueryKey(client.identity, artifactRevisionId);
			const refresh = () => {
				void cache.invalidateQueries({ queryKey }, { cancelRefetch: false });
			};
			refresh();
			return client.subscribeChanges(refresh);
		}, [artifactRevisionId, cache, client, source, visible]);
		const base = genericWebAdapter.useArtifact(context);
		if (!source) return base;
		return {
			...base,
			phase: agenda.isError
				? { kind: "error", message: "予約一覧を読み込めません。" }
				: agenda.data
					? { kind: "ready" }
					: { kind: "loading" },
			snapshot: agenda.data ? { [source]: agenda.data } : {},
			refresh: () => {
				void agenda.refetch();
			},
		};
	},
};
