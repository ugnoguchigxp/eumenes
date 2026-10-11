import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { EumenesClient } from "../../../../client";
import type { MusicResource } from "@eumenes/artifact-ui/contracts";
import { queryRoots } from "../../queryKeys";
type Item = Awaited<ReturnType<EumenesClient["musicList"]>>[number];
const running = (state?: string) => state === "queued" || state === "running";

/** Uses the normal authenticated conversation and cancellation APIs. */
export function useMusicCreation(
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
		queryKey: [queryRoots.music, "creation-run", conversationId, runId],
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
			queryKey: [queryRoots.music, "list", conversationId],
		});
	}, [cache, conversationId, runRevision]);
	const submitted = runId
		? items.find((item) => item.runId === runId)
		: undefined;
	const active = items.find(
		(item) => item.state === "planning" || item.state === "generating",
	);
	const statusItem = submitted ?? active ?? initial;
	const busy = !!active || running(run.data?.status);
	const cancelRunId =
		active?.runId ?? (running(run.data?.status) ? runId : undefined);
	const refresh = () => {
		for (const root of [
			queryRoots.music,
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
		const result = await client.submit({
			requestId: request.requestId,
			conversationId,
			text: `次の制作プロンプトで楽曲を1曲作成してください。\n\n${prompt}`,
		});
		pending.current = undefined;
		cache.setQueryData(
			[queryRoots.music, "creation-run", conversationId, result.id],
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
				[queryRoots.music, "creation-run", conversationId, runId],
				result,
			);
		refresh();
	};
	const runFailed =
		run.data && ["failed", "interrupted"].includes(run.data.status);
	const runCancelled = run.data?.status === "cancelled";
	const missingResult = run.data?.status === "completed" && !submitted;
	const status: NonNullable<MusicResource["creation"]>["status"] =
		runFailed || run.error || missingResult
			? "failed"
			: runCancelled
				? "cancelled"
				: statusItem?.state === "planning"
					? "pending"
					: statusItem?.state === "generating" || running(run.data?.status)
						? "running"
						: statusItem?.state === "failed"
							? "failed"
							: statusItem?.state === "cancelled"
								? "cancelled"
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
					? "楽曲を作成できませんでした"
					: status === "cancelled"
						? "楽曲の制作を取り消しました"
						: "楽曲を生成しています",
			description:
				statusItem?.state === "planning"
					? "テーマから曲調を考えています。"
					: running(run.data?.status) && !submitted
						? "制作依頼を受け付けました。"
						: undefined,
			canCancel: !!cancelRunId,
		},
	};
}
