import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { EumenesClient } from "../../../client";
import type { AnalysisDomain } from "../../../client/visual-analysis";
import {
	perceptionOptions,
	type AnalysisRecord,
} from "../../../api/domains/larm/contracts";
import type { ArtifactEvent, Receipt } from "@eumenes/artifact-ui/contracts";

export function useVisualAnalysis(
	client: EumenesClient,
	domain: AnalysisDomain,
	conversationId: string,
	source:
		| {
				id: string;
				revision: number;
				mime: string;
				state: string;
				result: {
					kind: string;
					frames?: { timestampSeconds: number }[];
				} | null;
		  }
		| undefined,
	frameIndex: number,
) {
	const frame = source?.result?.kind === "video" ? frameIndex : undefined;
	const scope = `${source?.id}:${source?.revision}:${frame ?? -1}`;
	const available =
		!!source &&
		(source.mime.startsWith("image/")
			? ["completed", "failed", "cancelled"].includes(source.state)
			: source.state === "completed" && !!source.result?.frames?.[frameIndex]);
	const [opened, setOpened] = useState<string>();
	const [chosen, setChosen] = useState<{ scope: string; id: string }>();
	const [error, setError] = useState<{ scope: string; message: string }>();
	const [pending, setPending] = useState(false);
	const lock = useRef(false);
	const records = useQuery({
		queryKey: [domain, client.identity, "analyses", conversationId, scope],
		enabled: available,
		retry: false,
		queryFn: ({ signal }) =>
			client.analysesList(domain, source!.id, conversationId, frame, signal),
	});
	const matching = (records.data ?? []).filter(
		(r) => r.sourceRevision === source?.revision,
	);
	const analysis =
		matching.find((r) => chosen?.scope === scope && r.id === chosen.id) ??
		matching[0];
	const assets = useQuery({
		queryKey: [
			domain,
			client.identity,
			"analysis-assets",
			conversationId,
			analysis?.id,
		],
		enabled: analysis?.state === "completed",
		retry: false,
		staleTime: "static",
		queryFn: async ({ signal }) => {
			const id = analysis!.id;
			const [image, ...masks] = await Promise.all([
				client.analysisAsset(
					domain,
					source!.id,
					id,
					conversationId,
					"image",
					signal,
				),
				...(analysis!.result?.masks ?? []).map((_, i) =>
					client.analysisAsset(
						domain,
						source!.id,
						id,
						conversationId,
						`masks/${i}`,
						signal,
					),
				),
			]);
			return { id, image: image!, masks };
		},
	});
	const [urls, setUrls] = useState<{
		id: string;
		image: string;
		masks: string[];
	}>();
	useEffect(() => {
		if (!assets.data) return;
		const data = assets.data;
		const image = URL.createObjectURL(data.image);
		const masks = data.masks.map((blob) => URL.createObjectURL(blob));
		let active = true;
		queueMicrotask(() => {
			if (active) setUrls({ id: data.id, image, masks });
		});
		return () => {
			active = false;
			URL.revokeObjectURL(image);
			masks.forEach((url) => URL.revokeObjectURL(url));
		};
	}, [assets.data]);
	async function start(options: AnalysisRecord["options"], requestId: string) {
		if (!source) return;
		try {
			const receipt = await client.analysisCreate(domain, source.id, {
				...options,
				requestId,
				conversationId,
				expectedRevision: source.revision,
				frameIndex: frame,
			});
			setChosen({ scope, id: receipt.id });
		} catch (cause) {
			const receipt = await client
				.analysisGet(domain, source.id, requestId, conversationId)
				.catch(() => null);
			if (!receipt) throw cause;
			setChosen({ scope, id: receipt.id });
		}
		await records.refetch();
	}
	async function dispatch(event: ArtifactEvent): Promise<Receipt> {
		if (
			!available ||
			!source ||
			event.values.id !== source.id ||
			event.values.scope !== scope
		)
			return {
				status: "rejected",
				message: "対象の画像・時刻を選び直してください。",
			};
		if (lock.current)
			return { status: "rejected", message: "詳細分析の受付中です。" };
		lock.current = true;
		setPending(true);
		setOpened(scope);
		setError(undefined);
		try {
			if (event.action === "analysis-open") {
				const fresh = await records.refetch();
				if (fresh.error) throw fresh.error;
				if (!fresh.data?.some((r) => r.sourceRevision === source.revision))
					await start(
						{
							task: "describe",
							query: "この画像で何が起きているか説明してください。",
						},
						event.id,
					);
			} else if (event.action === "analysis-run") {
				const options = perceptionOptions.parse(
					JSON.parse(String(event.values.options)),
				);
				if (
					matching.some((r) =>
						["queued", "starting", "running", "cancelling"].includes(r.state),
					)
				)
					return {
						status: "rejected",
						message: "実行中の分析が終わるまでお待ちください。",
					};
				await start(options, event.id);
			} else if (event.action === "analysis-select") {
				const id = String(event.values.analysisId);
				if (!matching.some((r) => r.id === id))
					throw new Error("unknown_analysis");
				setChosen({ scope, id });
			} else if (
				event.action === "analysis-cancel" &&
				analysis &&
				event.values.analysisId === analysis.id
			) {
				await client.analysisCancel(
					domain,
					source.id,
					analysis.id,
					conversationId,
				);
				await records.refetch();
			} else
				return { status: "rejected", message: "分析を選び直してください。" };
			return {
				status: "accepted",
				message:
					event.action === "analysis-open"
						? "詳細分析を開きました。"
						: "操作を受け付けました。",
			};
		} catch {
			setError({
				scope,
				message:
					"詳細分析の受付または取得を確認できませんでした。自動再送はしていません。",
			});
			return {
				status: "rejected",
				message: "詳細分析の受付または取得を確認できませんでした。",
			};
		} finally {
			lock.current = false;
			setPending(false);
		}
	}
	return {
		resource: {
			analysisAvailable: available,
			analysisScope: scope,
			analysisOpen: opened === scope,
			analysisRecords: matching,
			analysis,
			analysisPending: pending,
			analysisImageUrl: urls?.id === analysis?.id ? urls?.image : undefined,
			analysisMaskUrls: urls?.id === analysis?.id ? urls?.masks : undefined,
			analysisError:
				error?.scope === scope
					? error.message
					: records.error || assets.error
						? "詳細分析の結果を取得できませんでした。"
						: undefined,
		},
		revision:
			matching.reduce((sum, r) => sum + r.updatedAt, 0) +
			assets.dataUpdatedAt +
			(opened === scope ? 1 : 0) +
			(pending ? 1 : 0),
		dispatch,
		refresh: () => records.refetch(),
	};
}
