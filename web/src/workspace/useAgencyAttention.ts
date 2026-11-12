import { useEffect, useRef, useState } from "react";
import type { EumenesClient } from "../../../client";

/** The field is still this long: the user is not typing any more (the agenda host's own rule). */
export const TYPING_IDLE_MS = 4_000;

/**
 * Whether the user is typing: text they wrote themselves, changed within the last moments. Text the voice session
 * put in the field, or a draft left as it is, is not typing (a field that merely holds text held the agent for hours).
 */
export function useTyping(draft: { text: string; dictated: boolean }) {
	const [typing, setTyping] = useState(false);
	const own = draft.text.length > 0 && !draft.dictated;
	useEffect(() => {
		// The field's change is the event; the state follows it and ends on its own.
		// eslint-disable-next-line react/set-state-in-effect
		setTyping(own);
		if (!own) return;
		const timer = setTimeout(() => setTyping(false), TYPING_IDLE_MS);
		return () => clearTimeout(timer);
	}, [own, draft.text]);
	return typing;
}

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
