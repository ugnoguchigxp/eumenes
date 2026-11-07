import { useEffect, useRef, useState } from "react";
import type { MarkdownDraft } from "./types";
export type MarkdownCacheState =
	"idle" | "waiting" | "saving" | "saved" | "error";
export function useCacheAutosave(input: {
	enabled: boolean;
	composing: boolean;
	change: number;
	documentId: string;
	revision: number;
	snapshot(): { draft: MarkdownDraft; markdown: string };
	save(
		draft: MarkdownDraft,
		markdown: string,
		requestId: string,
	): Promise<boolean>;
}) {
	const token = JSON.stringify([
		input.documentId,
		input.revision,
		input.change,
	]);
	const [state, setState] = useState<{
		phase: MarkdownCacheState;
		token: string;
	}>({ phase: "idle", token: "" });
	const latest = useRef(input);
	const queue = useRef(Promise.resolve());
	const last = useRef<{
		signature: string;
		requestId: string;
		saved: boolean;
	} | null>(null);
	useEffect(() => {
		latest.current = input;
	}, [input]);
	useEffect(() => {
		if (!input.enabled || input.composing) return;
		let active = true;
		const timer = setTimeout(() => {
			// Prepare only when this request reaches the front. Pending edits never retain full copies of old documents.
			queue.current = queue.current
				.catch(() => {})
				.then(async () => {
					if (!active) return;
					try {
						const { draft, markdown } = latest.current.snapshot(),
							signature = JSON.stringify({ draft, markdown });
						if (last.current?.signature === signature && last.current.saved) {
							setState({ phase: "saved", token });
							return;
						}
						const requestId =
							last.current?.signature === signature
								? last.current.requestId
								: crypto.randomUUID();
						last.current = { signature, requestId, saved: false };
						setState({ phase: "saving", token });
						const saved = await latest.current.save(draft, markdown, requestId);
						if (last.current.signature === signature)
							last.current.saved = saved;
						if (active) setState({ phase: saved ? "saved" : "error", token });
					} catch {
						if (active) setState({ phase: "error", token });
					}
				});
		}, 1000);
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [input.enabled, input.composing, token]);
	return !input.enabled
		? "idle"
		: input.composing || state.token !== token
			? "waiting"
			: state.phase;
}
