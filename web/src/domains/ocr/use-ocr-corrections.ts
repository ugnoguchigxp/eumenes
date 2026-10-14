import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ArtifactEvent, Receipt } from "@eumenes/artifact-ui/contracts";
import type { EumenesClient } from "../../../../client";
import type { OcrRecord } from "../../../../api/domains/ocr/contracts";
import { ApiError } from "../../../../client/transport";
import { queryRoots } from "../../queryKeys";

const correctionStartErrors: Record<string, string> = {
	ocr_correction_busy: "この資料は補正中です。進行中の案を確認してください。",
	ocr_correction_capacity: "この資料の補正履歴が上限に達しました。",
	ocr_correction_unavailable:
		"補正を開始できません。LLMの接続と担当設定を確認してください。",
	ocr_correction_text_too_large: "この資料は補正できる文字量を超えています。",
	ocr_not_ready: "OCRが完了してから補正してください。",
	revision_conflict: "OCR結果が更新されました。資料を読み込み直してください。",
};

export function useOcrCorrections(
	client: EumenesClient,
	conversationId: string,
	selected: OcrRecord | undefined,
	frameIndex: number,
	onError: (message: string) => void,
	onEvidence: (evidence: {
		lineIndexes: number[];
		region?: [number, number, number, number];
	}) => void,
) {
	const cache = useQueryClient();
	const selectedId = selected?.id;
	const frame = selected?.result?.kind === "video" ? frameIndex : undefined;
	const scope = `${selectedId ?? ""}:${frame ?? -1}`;
	const query = useQuery({
		queryKey: [
			queryRoots.ocr,
			client.identity,
			"corrections",
			selectedId,
			frame,
			selected?.revision,
		],
		enabled: !!selectedId && selected?.state === "completed",
		queryFn: ({ signal }) =>
			client.ocrCorrections(
				selectedId!,
				conversationId,
				frame,
				undefined,
				signal,
			),
		refetchInterval: (q) =>
			q.state.data?.items.some((c) =>
				["queued", "running", "cancelling"].includes(c.state),
			)
				? 1000
				: false,
	});
	const [selectedCandidateId, setSelectedCandidateId] = useState<string>();
	const [extra, setExtra] = useState<{
		key: string;
		items: NonNullable<typeof query.data>["items"];
		nextCursor: number | null;
	}>();
	const firstPage = query.data?.items ?? [];
	const firstIds = new Set(firstPage.map((c) => c.id));
	const items = [
		...firstPage,
		...(extra?.key === scope
			? extra.items.filter((c) => !firstIds.has(c.id))
			: []),
	];
	const nextCursor =
		extra?.key === scope ? extra.nextCursor : query.data?.nextCursor;
	const resource = {
		corrections: items,
		correctionSelectedId: selectedCandidateId,
		correctionPreferredId: query.data?.preference.preferredId,
		correctionPreferenceRevision: query.data?.preference.revision,
		correctionHasMore: nextCursor != null,
		correctionLoading: query.isPending && selected?.state === "completed",
	};
	const revision =
		(query.dataUpdatedAt || 0) +
		(query.data?.preference.revision ?? 0) +
		(items.findIndex((c) => c.id === selectedCandidateId) + 1);
	async function dispatch(event: ArtifactEvent): Promise<Receipt> {
		const id = typeof event.values.id === "string" ? event.values.id : "";
		if (id !== selectedId || !selected || selected.state !== "completed")
			return { status: "rejected", message: "資料を選び直してください。" };
		const candidateId =
			typeof event.values.candidateId === "string"
				? event.values.candidateId
				: "";
		if (event.action === "ocr-correction-start") {
			onError("");
			try {
				await client.ocrCorrectionCreate(id, {
					requestId: event.id,
					conversationId,
					expectedRevision: selected.revision,
					frameIndex: frame,
				});
			} catch (cause) {
				if (cause instanceof ApiError && correctionStartErrors[cause.message]) {
					await query.refetch();
					const message = correctionStartErrors[cause.message]!;
					onError(message);
					return { status: "rejected", message };
				}
				const prior = await client
					.ocrCorrectionGet(id, event.id, conversationId)
					.catch(() => null);
				if (!prior) {
					onError(
						cause instanceof ApiError
							? cause.message
							: "受付を確認できませんでした。自動再送はしていません。",
					);
					return {
						status: "rejected",
						message: "補正の受付を確認できませんでした。",
					};
				}
			}
			setSelectedCandidateId(event.id);
			await query.refetch();
			return { status: "accepted", message: "補正案の作成を受け付けました。" };
		}
		if (event.action === "ocr-correction-more") {
			if (nextCursor != null) {
				const page = await client.ocrCorrections(
					id,
					conversationId,
					frame,
					nextCursor,
				);
				setExtra({
					key: scope,
					items: [...(extra?.key === scope ? extra.items : []), ...page.items],
					nextCursor: page.nextCursor,
				});
			}
			return { status: "accepted", message: "履歴を表示しました。" };
		}
		if (event.action === "ocr-correction-original") {
			await client.ocrCorrectionPrefer(id, {
				conversationId,
				frameIndex: frame,
				preferredId: null,
				expectedRevision: query.data?.preference.revision ?? 0,
			});
			await query.refetch();
			return { status: "accepted", message: "原文を既定表示に戻しました。" };
		}
		const candidate = items.find((c) => c.id === candidateId);
		if (
			!candidate ||
			candidate.sourceId !== id ||
			candidate.frameIndex !== (frame ?? null)
		)
			return { status: "rejected", message: "補正案を選び直してください。" };
		if (event.action === "ocr-correction-evidence") {
			const blockIndex = Number(event.values.blockIndex);
			const row =
				event.values.row === "" ? undefined : Number(event.values.row);
			const column =
				event.values.column === "" ? undefined : Number(event.values.column);
			if (!Number.isInteger(blockIndex) || blockIndex < 0 || !candidate.result)
				return { status: "rejected", message: "根拠を表示できません。" };
			const block = candidate.result.blocks[blockIndex];
			if (!block)
				return { status: "rejected", message: "根拠を表示できません。" };
			const evidence =
				block.kind === "paragraph" && row === undefined && column === undefined
					? block.evidence
					: block.kind === "table" &&
						  Number.isInteger(row) &&
						  Number.isInteger(column)
						? block.cells.find((c) => c.row === row && c.column === column)
								?.evidence
						: undefined;
			if (!evidence)
				return { status: "rejected", message: "根拠を表示できません。" };
			onEvidence(evidence);
			return { status: "accepted", message: "元画像の根拠を選びました。" };
		}
		if (event.action === "ocr-correction-select") {
			setSelectedCandidateId(candidateId);
			return { status: "accepted", message: "補正案を選びました。" };
		}
		if (event.action === "ocr-correction-cancel") {
			await client.ocrCorrectionCancel(id, candidateId, conversationId);
			await query.refetch();
			return { status: "accepted", message: "補正を中止しました。" };
		}
		if (event.action === "ocr-correction-prefer") {
			await client.ocrCorrectionPrefer(id, {
				conversationId,
				frameIndex: frame,
				preferredId: candidateId,
				expectedRevision: query.data?.preference.revision ?? 0,
			});
			await query.refetch();
			return { status: "accepted", message: "補正案を採用しました。" };
		}
		if (event.action === "ocr-correction-incorporate") {
			await client.ocrCorrectionIncorporate(
				id,
				candidateId,
				event.id,
				conversationId,
			);
			await Promise.all([
				cache.invalidateQueries({ queryKey: [queryRoots.conversation] }),
				cache.invalidateQueries({ queryKey: [queryRoots.dialogue] }),
			]);
			return { status: "accepted", message: "補正案を会話に追加しました。" };
		}
		return { status: "rejected", message: "未対応の操作です。" };
	}
	return {
		resource,
		revision,
		dispatch,
		refresh: () => query.refetch(),
		reset: () => {
			setSelectedCandidateId(undefined);
			setExtra(undefined);
		},
	};
}
