import { useEffect, useRef } from "react";
import { requestPlayback } from "@eumenes/design-system";
import type { EumenesClient } from "../../../../client";

type Item = Awaited<ReturnType<EumenesClient["musicList"]>>[number];

/** Only newly completed generations request playback, never an opened history item. */
export function useMusicAutoplay(
	conversationId: string,
	items: Item[] | undefined,
	selectedId: string | undefined,
	audioId: string | undefined,
) {
	const observed = useRef<
		| {
				conversationId: string;
				known: Set<string>;
				pending: Set<string>;
		  }
		| undefined
	>(undefined);
	useEffect(() => {
		if (!items) return;
		const previous =
			observed.current?.conversationId === conversationId
				? observed.current
				: undefined;
		const pending = previous?.pending ?? new Set<string>();
		for (const item of items) {
			if (
				item.state === "planning" ||
				item.state === "generating" ||
				(item.state === "completed" && previous && !previous.known.has(item.id))
			)
				pending.add(item.id);
			if (
				item.state === "failed" ||
				item.state === "cancelled" ||
				(item.state === "completed" && item.id !== selectedId)
			)
				pending.delete(item.id);
		}
		const known = new Set(items.map((item) => item.id));
		for (const id of pending) if (!known.has(id)) pending.delete(id);
		observed.current = { conversationId, known, pending };
		if (
			selectedId &&
			audioId === selectedId &&
			items.some(
				(item) => item.id === selectedId && item.state === "completed",
			) &&
			pending.delete(selectedId)
		) {
			// Audio is already mounted. Do not leave a request waiting after a selection change.
			// The player itself highlights its play button when the browser refuses autoplay.
			void requestPlayback(selectedId, 0).catch(() => {});
		}
	}, [conversationId, items, selectedId, audioId]);
}
