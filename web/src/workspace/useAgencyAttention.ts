import { useEffect } from "react";
import type { EumenesClient } from "../../../client";

/** Visible-screen presence only; background work and speech limits remain owned by the server. */
export function useAgencyAttention(
	client: Pick<EumenesClient, "agencyAttention">,
	conversationId: string,
) {
	useEffect(() => {
		let current: AbortController | null = null;
		const notify = () => {
			if (document.visibilityState !== "visible") {
				current?.abort();
				current = null;
				return;
			}
			if (current) return;
			const controller = new AbortController();
			current = controller;
			void client
				.agencyAttention(conversationId, controller.signal)
				.catch(() => {})
				.finally(() => {
					if (current === controller) current = null;
				});
		};
		notify();
		const timer = setInterval(notify, 15_000);
		document.addEventListener("visibilitychange", notify);
		return () => {
			clearInterval(timer);
			document.removeEventListener("visibilitychange", notify);
			current?.abort();
		};
	}, [client, conversationId]);
}
