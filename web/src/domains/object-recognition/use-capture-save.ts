import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { EumenesClient } from "../../../../client";
import { ApiError } from "../../../../client/transport";
import type { RecognitionRecord } from "../../../../api/domains/object-recognition/contracts";
import { imageLibraryKey } from "../../media/use-image-library";
import { queryRoots } from "../../queryKeys";

export function useCaptureSave(
	client: EumenesClient,
	selected?: RecognitionRecord,
	items: readonly RecognitionRecord[] = [],
) {
	const cache = useQueryClient();
	const receipt = useQuery({
		queryKey: [
			queryRoots.objectRecognition,
			client.identity,
			"capture-save",
			selected?.id,
		],
		enabled: !!selected && selected.captureSave === "unconfirmed",
		queryFn: ({ signal }) => client.imageImport(selected!.id, signal),
		retry: false,
		refetchInterval: (query) =>
			query.state.data?.status === "pending"
				? Math.max(1000, query.state.data.retryAfterMs)
				: false,
	});
	const receiptStatus =
		selected?.captureSave === "unconfirmed" ? receipt.data?.status : undefined;
	const noReceipt =
		selected?.captureSave === "unconfirmed" &&
		receipt.error instanceof ApiError &&
		receipt.error.status === 404 &&
		receipt.error.message === "image_import_not_found";
	const status =
		receiptStatus === "succeeded" && receipt.data?.artifact
			? "saved"
			: receiptStatus &&
				  ["failed", "blocked", "deleted", "expired"].includes(receiptStatus)
				? "failed"
				: receiptStatus === "pending"
					? // LARM accepted the image and is still storing it; the receipt is polled.
						"queued"
					: selected?.captureSave;
	const invalidated = useRef<string | undefined>(undefined);
	const seen = useRef(new Set<string>());
	useEffect(() => {
		const added = items.some(
			(item) => item.captureSave === "saved" && !seen.current.has(item.id),
		);
		for (const item of items)
			if (item.captureSave === "saved") seen.current.add(item.id);
		if (added)
			void cache.invalidateQueries({ queryKey: imageLibraryKey(client) });
	}, [cache, client, items]);
	// A save the receipt confirmed while the record still says otherwise; the effect above covers the record.
	const receiptSaved = status === "saved" && selected?.captureSave !== "saved";
	useEffect(() => {
		if (receiptSaved && selected?.id && invalidated.current !== selected.id) {
			invalidated.current = selected.id;
			void cache.invalidateQueries({ queryKey: imageLibraryKey(client) });
		}
	}, [cache, client, selected?.id, receiptSaved]);
	return {
		status,
		canResume: receiptStatus === "ready" || noReceipt,
		async recheck() {
			const result = await receipt.refetch();
			return result.error
				? {
						status: "rejected" as const,
						message: "保存状態を確認できませんでした。",
					}
				: { status: "accepted" as const, message: "保存状態を確認しました。" };
		},
		async resume() {
			if (!selected || (receiptStatus !== "ready" && !noReceipt))
				return {
					status: "rejected" as const,
					message: "保存状態を再確認してください。",
				};
			try {
				if (noReceipt) {
					await client.recognitionResumeCaptureSave(selected.id);
					return {
						status: "accepted" as const,
						message: "保存を再開しました。",
					};
				}
				const result = await client.resumeImageImport(selected.id);
				cache.setQueryData(
					[
						queryRoots.objectRecognition,
						client.identity,
						"capture-save",
						selected.id,
					],
					result,
				);
				return {
					status: "accepted" as const,
					message: "保存状態を更新しました。",
				};
			} catch (error) {
				return {
					status: "rejected" as const,
					message:
						error instanceof ApiError &&
						error.message === "capture_save_connection_changed"
							? "LARMの接続先または認証が変わったため、保存を再開できません。"
							: "保存状態を確認できませんでした。",
				};
			}
		},
	};
}
