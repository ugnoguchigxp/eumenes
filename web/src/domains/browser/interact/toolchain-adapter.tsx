import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { WebArtifactAdapter } from "../../toolchain-artifacts/registry";
import { queryRoots } from "../../../queryKeys";
import {
	selectedInteractCapture,
	interactSnapshot,
	interactWorkspace,
	type InteractWorkspace,
} from "./view-model";

/** Reads canonical domain state and authenticated media; all writes use the common Artifact outbox. */
export const browserInteractWebAdapter: WebArtifactAdapter = {
	adapterRef: "adapter:browser.interact@1",
	useArtifact(context) {
		const cache = useQueryClient();
		const conversationId = context.conversationId ?? "main";
		const key = [
			queryRoots.toolchainArtifacts,
			context.client.identity,
			context.artifactRevisionId,
			"interact",
			conversationId,
			context.targetRef,
		];
		const query = useQuery<InteractWorkspace>({
			queryKey: key,
			enabled: context.visible,
			refetchInterval: (q) =>
				context.visible &&
				q.state.data?.runs.some((r) =>
					["queued", "running", "needs_input"].includes(r.state),
				)
					? 500
					: false,
			queryFn: async ({ signal }) =>
				interactWorkspace.parse(
					(
						await context.client.toolchainArtifactSource(
							context.artifactRevisionId,
							"runs",
							context.targetRef,
							signal,
							{ conversationId },
						)
					).data,
				),
		});
		const capture = selectedInteractCapture(query.data);
		const captureId = capture?.captureId;
		const mediaKey = [...key, "capture", captureId];
		const media = useQuery({
			queryKey: mediaKey,
			enabled: context.visible && !!captureId,
			queryFn: ({ signal }) =>
				context.client.toolchainMedia(
					`/api/browser/captures/${encodeURIComponent(captureId!)}/content`,
					signal,
				),
		});
		const [image, setImage] = useState<{ id: string; url: string }>();
		useEffect(() => {
			if (!media.data || !captureId) {
				setImage(undefined);
				return;
			}
			const url = URL.createObjectURL(media.data);
			setImage({ id: captureId, url });
			return () => URL.revokeObjectURL(url);
		}, [media.data, captureId]);
		const refresh = () => {
			void query.refetch();
		};
		return {
			phase: query.isError
				? { kind: "error", message: "作業の情報を取得できませんでした。" }
				: query.isPending
					? { kind: "loading" }
					: { kind: "ready" },
			snapshot: interactSnapshot(
				query.data ?? { runs: [], selected: null },
				conversationId,
				Date.now(),
				image?.id === captureId ? image?.url : undefined,
			),
			targetOf: (source) =>
				["result", "reply", "forget"].includes(source)
					? query.data?.selected?.runId
					: undefined,
			async local(binding, event) {
				if (binding.actionId === "select") {
					const id = event.values.taskRef;
					if (
						typeof id !== "string" ||
						!query.data?.runs.some((r) => r.runId === id)
					)
						return {
							status: "rejected",
							message: "作業を選び直してください。",
						};
					context.setTargetRef(id);
				} else refresh();
				return { status: "accepted", message: "読み直しました。" };
			},
			settled(binding, result) {
				if (binding.actionId === "forget") {
					context.setTargetRef(undefined);
					cache.removeQueries({
						queryKey: [
							queryRoots.toolchainArtifacts,
							context.client.identity,
							context.artifactRevisionId,
						],
					});
					setImage(undefined);
				} else if (binding.actionId === "start") {
					const receipt = result.receipt as { runId?: string };
					if (receipt?.runId) context.setTargetRef(receipt.runId);
				}
				refresh();
			},
			refresh,
			describeRejection(code) {
				return code === "browser_interact_answer_stale"
					? "確認内容が更新されています。最新の質問を読み直してから回答してください。"
					: code === "browser_interact_parent_answer_required" ||
						  code === "browser_interact_parent_forget_required" ||
						  code === "browser_interact_parent_control_required"
						? "この作業の回答・取消・削除は、依頼した会話から行ってください。"
						: undefined;
			},
		};
	},
};
