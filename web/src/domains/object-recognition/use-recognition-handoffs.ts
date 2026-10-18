import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { EumenesClient } from "../../../../client";
import type {
	Handoff,
	RecognitionRecord,
} from "../../../../api/domains/object-recognition/contracts";
import { queryRoots } from "../../queryKeys";
const finished = ["completed", "failed", "cancelled"];

/**
 * The conversation's capture and "show this image" requests while this screen is open. A request is
 * answered by a still (taken here, or the saved one it names); once that still's detection ended,
 * even unsuccessfully, the host sends it to the conversation.
 */
export function useRecognitionHandoffs(
	client: EumenesClient,
	conversationId: string,
	items: RecognitionRecord[],
	onError: (message: string) => void,
) {
	const cache = useQueryClient();
	const handoffs = useQuery({
		queryKey: [queryRoots.objectRecognition, client.identity, "handoffs"],
		queryFn: ({ signal }) => client.recognitionHandoffs(conversationId, signal),
		refetchInterval: 1500,
	});
	/** Stills taken here for a request: handoff id → the record that answers it. */
	const [taken, setTaken] = useState<ReadonlyMap<string, string>>(new Map());
	const sending = useRef(new Set<string>());
	const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
	// The host's record wins: a saved-image request names its record, and a capture request is bound
	// to the first still uploaded for it (so a reload or another tab never takes a second one).
	const answering = useMemo(() => {
		const all = new Map(taken);
		for (const h of handoffs.data ?? [])
			if (h.recognitionId && !dismissed.has(h.id))
				all.set(h.id, h.recognitionId);
		return all;
	}, [taken, handoffs.data, dismissed]);
	const capture = (handoffs.data ?? []).find(
		(h): h is Handoff & { source: "camera" | "screen" } =>
			h.source !== "saved" &&
			!h.recognitionId &&
			!dismissed.has(h.id) &&
			!taken.has(h.id),
	);
	const refetch = handoffs.refetch;
	useEffect(() => {
		for (const [handoffId, recognitionId] of answering) {
			const r = items.find((i) => i.id === recognitionId);
			if (!r || !finished.includes(r.state) || sending.current.has(handoffId))
				continue;
			sending.current.add(handoffId);
			const saved = (handoffs.data ?? []).some(
				(h) => h.id === handoffId && h.source === "saved",
			);
			void client
				.recognitionHandoffSend(handoffId, saved ? undefined : recognitionId)
				.then(async () => {
					await cache.invalidateQueries({
						queryKey: [queryRoots.conversation],
					});
					await cache.invalidateQueries({ queryKey: [queryRoots.dialogue] });
				})
				.catch(() =>
					onError(
						"撮影した画像を会話に送れませんでした。もう一度依頼してください。",
					),
				)
				.finally(() => {
					setDismissed((d) => new Set(d).add(handoffId));
					setTaken((m) => {
						const next = new Map(m);
						next.delete(handoffId);
						return next;
					});
					sending.current.delete(handoffId);
					void refetch();
				});
		}
	}, [answering, items, handoffs.data, client, cache, refetch, onError]);
	return {
		/** The capture request the screen should take a still for now. */
		capture,
		/** A still was saved for this request. */
		answer: (handoffId: string, recognitionId: string) =>
			setTaken((m) => new Map(m).set(handoffId, recognitionId)),
		async cancel(id: string) {
			setDismissed((d) => new Set(d).add(id));
			await client.recognitionHandoffCancel(id).catch(() => null);
			await refetch();
		},
	};
}
