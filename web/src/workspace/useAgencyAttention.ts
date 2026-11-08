import { useEffect, useRef } from "react";
import type { EumenesClient } from "../../../client";

/** Screen leases contain activity flags only; no draft text is sent. */
export function useAgencyAttention(
	client: Pick<EumenesClient, "agencyAttention">,
	conversationId: string,
	activity: { typing: boolean; playing: boolean } = {
		typing: false,
		playing: false,
	},
) {
	const latest = useRef(activity);
	const notifyRef = useRef<(() => void) | null>(null);
	useEffect(() => {
		const screenId = crypto.randomUUID();
		let revision = 0;
		let current: AbortController | null = null;
		let last = "";
		const notify = (leaving = false, heartbeat = false) => {
			const flags = {
				...latest.current,
				visible: document.visibilityState === "visible",
				...(leaving ? { leaving: true } : {}),
			};
			const key = JSON.stringify(flags);
			if (key === last && (!heartbeat || current)) return;
			last = key;
			current?.abort();
			const controller = new AbortController();
			current = controller;
			void client
				.agencyAttention(conversationId, controller.signal, {
					screenId,
					revision: ++revision,
					sentAt: Date.now(),
					...flags,
				})
				.catch(() => {})
				.finally(() => {
					if (current === controller) current = null;
				});
		};
		const changed = () => notify();
		const leaving = () => notify(true);
		notifyRef.current = changed;
		notify();
		const timer = setInterval(() => notify(false, true), 15_000);
		document.addEventListener("visibilitychange", changed);
		window.addEventListener("pagehide", leaving);
		return () => {
			clearInterval(timer);
			document.removeEventListener("visibilitychange", changed);
			window.removeEventListener("pagehide", leaving);
			notifyRef.current = null;
			leaving();
		};
	}, [client, conversationId]);
	useEffect(() => {
		latest.current = { typing: activity.typing, playing: activity.playing };
		notifyRef.current?.();
	}, [activity.typing, activity.playing]);
}
