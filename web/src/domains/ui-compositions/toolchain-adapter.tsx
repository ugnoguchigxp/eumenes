import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Resource, Snapshot } from "@eumenes/artifact-ui/contracts";
import type { WebArtifactAdapter } from "../toolchain-artifacts/registry";
import { queryRoots } from "../../queryKeys";

export const UI_COMPOSITIONS_ADAPTER_REF = "adapter:ui-compositions@1";

export const uiCompositionsWebAdapter: WebArtifactAdapter = {
	adapterRef: UI_COMPOSITIONS_ADAPTER_REF,
	useArtifact({
		client,
		artifactRevisionId,
		targetRef,
		setTargetRef,
		visible,
	}) {
		const cache = useQueryClient();
		const list = useQuery({
			queryKey: [
				queryRoots.toolchainArtifacts,
				client.identity,
				"ui-compositions",
			],
			queryFn: ({ signal }) =>
				client.toolchainArtifactSource(
					artifactRevisionId,
					"ui-workshop",
					undefined,
					signal,
				),
			refetchInterval: (query) => {
				const data = query.state.data?.data as
					| { items?: Array<{ state: string }> }
					| undefined;
				return data?.items?.some((item) => item.state === "generating")
					? 1000
					: false;
			},
			enabled: visible,
		});
		const images = useQuery({
			queryKey: [queryRoots.image, "ui-motifs"],
			queryFn: ({ signal }) => client.imageLibrary(signal),
			retry: false,
			enabled: visible,
		});
		const form = useQuery({
			queryKey: [
				queryRoots.toolchainArtifacts,
				client.identity,
				"ui-form",
				targetRef,
			],
			queryFn: ({ signal }) =>
				client.toolchainArtifactSource(
					artifactRevisionId,
					"composition-form",
					targetRef,
					signal,
				),
			enabled:
				!!targetRef &&
				(
					list.data?.data as
						| { items?: Array<{ id: string; state: string }> }
						| undefined
				)?.items?.some(
					(item) => item.id === targetRef && item.state === "ready",
				),
			retry: false,
		});
		const raw = list.data?.data as
			| {
					kind?: string;
					items?: Array<{
						id: string;
						title: string;
						prompt?: string;
						state: "generating" | "ready" | "failed" | "cancelled";
						updatedAt: number;
						generation: number;
						definition?: unknown;
						description?: string;
						errorCode?: string;
						motifId?: string;
					}>;
			  }
			| undefined;
		const items = raw?.items ?? [];
		const workshop: Resource = {
			kind: "ui-workspace",
			revision: list.data?.revision ?? 0,
			items,
			selectedId: targetRef,
			images: (images.data?.images ?? []).map((image) => ({
				id: image.id,
				title: `画像 ${image.createdAt.slice(0, 10)}`,
			})),
		};
		const snapshot: Record<string, Resource> = { "ui-workshop": workshop };
		if (
			targetRef &&
			form.data?.data &&
			items.find((item) => item.id === targetRef)?.generation ===
				form.data.revision &&
			(form.data.data as { kind?: string }).kind === "form"
		)
			snapshot["composition-form"] = {
				...(form.data.data as Resource),
				revision: form.data.revision,
			};
		const refresh = () => {
			void cache.invalidateQueries({
				queryKey: [
					queryRoots.toolchainArtifacts,
					client.identity,
					"ui-compositions",
				],
			});
			void cache.invalidateQueries({
				queryKey: [queryRoots.toolchainArtifacts, client.identity, "ui-form"],
			});
		};
		return {
			phase: list.isError
				? { kind: "error", message: "保存したUIを読み込めません。" }
				: list.isPending
					? { kind: "loading" }
					: { kind: "ready" },
			snapshot: snapshot as Snapshot,
			targetOf: (source) =>
				source === "composition-form" ? targetRef : undefined,
			local: async (binding, event) => {
				if (binding.eventAction === "ui-select") {
					const id = event.values.id;
					if (
						typeof id !== "string" ||
						(id && !items.some((item) => item.id === id))
					)
						return { status: "rejected", message: "作品が見つかりません。" };
					setTargetRef(id || undefined);
					return { status: "accepted", message: "作品を開きました。" };
				}
				if (binding.eventAction === "ui-refresh") {
					refresh();
					return { status: "accepted", message: "更新しました。" };
				}
				return { status: "rejected", message: "この操作は利用できません。" };
			},
			settled: async (binding, result) => {
				if (binding.eventAction === "ui-generate") {
					const id = result.resultRefs.find(
						(ref) => ref.owner === "ui-compositions",
					)?.id;
					if (id) setTargetRef(id);
				}
				refresh();
			},
			refresh,
		};
	},
};
