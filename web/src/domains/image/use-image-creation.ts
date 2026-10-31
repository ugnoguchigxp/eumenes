import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { EumenesClient } from "../../../../client";
import type { ImageWorkspaceResource } from "@eumenes/artifact-ui/contracts";
import { queryRoots } from "../../queryKeys";
type Item = Awaited<ReturnType<EumenesClient["imageGenerations"]>>[number];
const running = (state?: string) => state === "queued" || state === "running";

/** Uses the normal authenticated conversation and cancellation APIs. */
export function useImageCreation(
	client: EumenesClient,
	conversationId: string,
	items: Item[],
	initial?: Item,
) {
	const cache = useQueryClient();
	const [runId, setRunId] = useState<string>();
	const pending = useRef<{ prompt: string; requestId: string } | undefined>(
		undefined,
	);
	const run = useQuery({
		queryKey: [queryRoots.image, "creation-run", conversationId, runId],
		queryFn: ({ signal }) => client.run(runId!, signal),
		enabled: !!runId,
		retry: false,
		refetchInterval: (query) =>
			running(query.state.data?.status) ? 1000 : false,
	});
	const runRevision = run.data?.revision;
	useEffect(() => {
		if (runRevision === undefined) return;
		void cache.invalidateQueries({
			queryKey: [queryRoots.image, "generations", conversationId],
		});
	}, [cache, conversationId, runRevision]);
	const submitted = runId
		? items.find((item) => item.runId === runId)
		: undefined;
	const active = items.find(
		(item) => item.state === "planning" || item.state === "generating",
	);
	const newer =
		!!submitted &&
		!!initial &&
		initial.id !== submitted.id &&
		initial.createdAt >= submitted.createdAt;
	const currentRun = newer ? undefined : run.data;
	const statusItem = active ?? (newer ? initial : (submitted ?? initial));
	const busy = !!active || running(currentRun?.status);
	const cancelRunId =
		active?.runId ?? (running(currentRun?.status) ? runId : undefined);
	const refresh = () => {
		for (const root of [
			queryRoots.image,
			queryRoots.dialogue,
			queryRoots.conversation,
		])
			void cache.invalidateQueries({ queryKey: [root] });
	};
	const generate = async (prompt: string) => {
		const request =
			pending.current?.prompt === prompt
				? pending.current
				: { prompt, requestId: crypto.randomUUID() };
		pending.current = request;
		const text = `次の入力の制作プロンプト・モデル・幅・高さ・保存形式・シードをそのまま使い、画像を1枚生成してください。\n\n${prompt}`;
		if (text.length > 8000) throw new Error("image_prompt_too_long");
		const result = await client.submit({
			requestId: request.requestId,
			conversationId,
			text,
			presentation: "artifact",
			toolchainId: "image.create",
		});
		pending.current = undefined;
		cache.setQueryData(
			[queryRoots.image, "creation-run", conversationId, result.id],
			result,
		);
		setRunId(result.id);
		refresh();
	};
	const cancel = async () => {
		if (!cancelRunId) return;
		const result = await client.cancel(cancelRunId);
		if (runId === cancelRunId)
			cache.setQueryData(
				[queryRoots.image, "creation-run", conversationId, runId],
				result,
			);
		refresh();
	};
	const runFailed =
		currentRun && ["failed", "interrupted"].includes(currentRun.status);
	const runCancelled = currentRun?.status === "cancelled";
	const missingResult = currentRun?.status === "completed" && !submitted;
	const status: ImageWorkspaceResource["status"] =
		runFailed || (!newer && run.error) || missingResult
			? "failed"
			: runCancelled
				? "cancelled"
				: statusItem?.state === "planning"
					? "pending"
					: statusItem?.state === "generating" || running(currentRun?.status)
						? "running"
						: statusItem?.state === "failed"
							? "failed"
							: statusItem?.state === "cancelled"
								? "cancelled"
								: statusItem?.state === "completed" &&
									  statusItem.action === "generate"
									? "completed"
									: undefined;
	return {
		runId,
		submitted,
		busy,
		generate,
		cancel,
		revision: run.data?.revision ?? 0,
		creation: {
			busy,
			status,
			title:
				status === "failed"
					? "画像を作成できませんでした"
					: status === "cancelled"
						? "画像の制作を取り消しました"
						: status === "completed"
							? "画像が完成しました"
							: "画像を生成しています",
			description:
				statusItem?.state === "planning"
					? "テーマから構図を考えています。"
					: running(currentRun?.status) && !submitted
						? "制作依頼を受け付けました。"
						: statusItem?.errorCode === "generation_unknown"
							? "通信が途切れ、生成結果を確認できませんでした。過去の画像の一覧を更新してください。"
							: statusItem?.errorCode === "larm_http_507"
								? "画像の保存容量が不足しています。"
								: statusItem?.errorCode === "image_model_unavailable"
									? "選択したモデルは準備中、または利用できません。"
									: statusItem?.errorCode === "media_variant_busy" ||
										  statusItem?.errorCode === "larm_http_409"
										? "ほかの重量級処理が実行中です。完了後に再度操作してください。"
										: statusItem?.errorCode === "larm_http_400"
											? "モデルと画像の設定を確認してください。"
											: undefined,
			canCancel: !!cancelRunId,
		},
	};
}
