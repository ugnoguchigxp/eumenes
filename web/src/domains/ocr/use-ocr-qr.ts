import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ArtifactEvent, Receipt } from "@eumenes/artifact-ui/contracts";
import type { EumenesClient } from "../../../../client";
import type { OcrRecord } from "../../../../api/domains/ocr/contracts";
import { ocrRegionBounds } from "@eumenes/design-system";
import { ApiError } from "../../../../client/transport";
import { queryRoots } from "../../queryKeys";

export function useOcrQr(
	client: EumenesClient,
	conversationId: string,
	selected: OcrRecord | undefined,
	frameIndex: number,
	onEvidence: (region: [number, number, number, number]) => void,
) {
	const cache = useQueryClient();
	const frame = selected?.result?.kind === "video" ? frameIndex : undefined;
	const scope = `${selected?.id}:${selected?.revision}:${frame ?? -1}`;
	const [startError, setStartError] = useState<{
		scope: string;
		message: string;
	}>();
	const starts = useRef(new Set<string>());
	const query = useQuery({
		queryKey: [
			queryRoots.ocr,
			client.identity,
			"qr",
			conversationId,
			selected?.id,
			selected?.revision,
			frame,
		],
		enabled: !!selected && selected.state === "completed",
		retry: false,
		queryFn: ({ signal }) =>
			client.ocrQr(selected!.id, conversationId, frame, signal),
		refetchInterval: (q) =>
			q.state.data &&
			["queued", "running", "cancelling"].includes(q.state.data.state)
				? 500
				: false,
	});
	const { data, isSuccess, refetch } = query;
	useEffect(() => {
		if (
			!selected ||
			selected.state !== "completed" ||
			!isSuccess ||
			data ||
			starts.current.has(scope)
		)
			return;
		starts.current.add(scope);
		const requestId = crypto.randomUUID();
		void client
			.ocrQrCreate(selected.id, {
				requestId,
				conversationId,
				expectedRevision: selected.revision,
				frameIndex: frame,
			})
			.catch(async (cause) => {
				if (cause instanceof ApiError && cause.message === "ocr_qr_busy")
					return;
				// Reconcile an unconfirmed POST by its receipt. Never automatically resend it.
				const receipt = await client
					.ocrQrGet(selected.id, requestId, conversationId)
					.catch(() => null);
				if (!receipt)
					throw new Error(
						"QR読取りの受付を確認できませんでした。自動再送はしていません。",
					);
			})
			.then(() => refetch())
			.catch((cause: unknown) => {
				setStartError({
					scope,
					message:
						cause instanceof Error
							? cause.message
							: "QR読取りの受付を確認できませんでした。",
				});
			});
	}, [
		client,
		conversationId,
		selected,
		frame,
		scope,
		isSuccess,
		data,
		refetch,
	]);
	async function dispatch(event: ArtifactEvent): Promise<Receipt> {
		const qr = query.data;
		if (
			!selected ||
			event.values.id !== selected.id ||
			!qr ||
			event.values.candidateId !== qr.id ||
			qr.sourceRevision !== selected.revision ||
			qr.frameIndex !== (frame ?? null)
		)
			return { status: "rejected", message: "QRの結果を選び直してください。" };
		if (event.action === "ocr-qr-cancel") {
			await client.ocrQrCancel(selected.id, qr.id, conversationId);
			await query.refetch();
			return {
				status: "accepted",
				message: "QR読取りの中止を受け付けました。",
			};
		}
		const index = Number(event.values.index);
		if (
			!Number.isInteger(index) ||
			index < 0 ||
			!qr.items?.[index] ||
			qr.state !== "completed"
		)
			return { status: "rejected", message: "QRの位置を選び直してください。" };
		if (event.action === "ocr-qr-evidence") {
			const region = ocrRegionBounds(qr.items[index]!.polygon);
			if (region) onEvidence(region);
			return { status: "accepted", message: "QRの位置を選びました。" };
		}
		if (event.action === "ocr-qr-incorporate") {
			await client.ocrQrIncorporate(
				selected.id,
				qr.id,
				conversationId,
				index,
				event.id,
			);
			await Promise.all([
				cache.invalidateQueries({ queryKey: [queryRoots.conversation] }),
				cache.invalidateQueries({ queryKey: [queryRoots.dialogue] }),
			]);
			return { status: "accepted", message: "QRの内容を会話に追加しました。" };
		}
		return { status: "rejected", message: "未対応の操作です。" };
	}
	return {
		resource: {
			qr: query.data,
			qrError:
				startError?.scope === scope
					? startError.message
					: query.error
						? "QRの結果を取得できませんでした。"
						: undefined,
		},
		revision: query.dataUpdatedAt,
		dispatch,
		refresh: () => query.refetch(),
	};
}
