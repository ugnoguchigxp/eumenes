import { useCallback, useEffect, useRef } from "react";
import type { EumenesClient } from "../../../../client";
import type {
	Drawing,
	DrawingSession,
} from "../../../../api/domains/excalidraw/contracts";
import { waitForDrawing } from "./editor-session";
export function useDrawingEditorLifecycle(options: {
	client: EumenesClient;
	/** Null for a new drawing: no lease until its first save. */
	referenceId: string | null;
	revision?: number;
	conversationId: string;
	onReady: (session: DrawingSession, drawing: Drawing) => void;
	onError: (message: string) => void;
	beforeLeave: () => boolean;
	onHide: () => void;
	onResume: () => Promise<void>;
	onDispose: () => void;
}) {
	const callbacks = useRef(options);
	const ownedSession = useRef<string | null>(null),
		lifetime = useRef<AbortController | null>(null);
	useEffect(() => {
		callbacks.current = options;
	});
	const { client, referenceId, revision, conversationId } = options;
	useEffect(() => {
		const abort = new AbortController();
		lifetime.current = abort;
		if (referenceId)
			void (async () => {
				try {
					const s = await client.openDrawing(
						{
							requestId: crypto.randomUUID(),
							referenceId,
							conversationId,
							...(revision ? { revision } : {}),
						},
						abort.signal,
					);
					if (abort.signal.aborted) {
						await client.releaseDrawing(s.id);
						return;
					}
					ownedSession.current = s.id;
					const ready = await waitForDrawing(client, s, abort.signal);
					const doc = await client.drawingDocument(s.id, abort.signal);
					if (!abort.signal.aborted) callbacks.current.onReady(ready, doc);
				} catch (error) {
					if (!abort.signal.aborted)
						callbacks.current.onError(
							error instanceof Error ? error.message : "接続できませんでした。",
						);
				}
			})();
		const before = (event: BeforeUnloadEvent) => {
			if (callbacks.current.beforeLeave()) {
				event.preventDefault();
				event.returnValue = "";
			}
		};
		const hide = () => {
			callbacks.current.beforeLeave();
			callbacks.current.onHide();
			if (ownedSession.current)
				void client.releaseDrawing(ownedSession.current).catch(() => {});
		};
		const show = (event: PageTransitionEvent) => {
			if (event.persisted) void callbacks.current.onResume();
		};
		window.addEventListener("pagehide", hide);
		window.addEventListener("pageshow", show);
		window.addEventListener("beforeunload", before);
		return () => {
			abort.abort();
			callbacks.current.onDispose();
			window.removeEventListener("pagehide", hide);
			window.removeEventListener("pageshow", show);
			window.removeEventListener("beforeunload", before);
			if (ownedSession.current)
				void client.releaseDrawing(ownedSession.current).catch(() => {});
		};
	}, [client, referenceId, revision, conversationId]);
	const signal = useCallback(
		() => lifetime.current?.signal ?? AbortSignal.abort(),
		[],
	);
	const accept = useCallback((id: string) => {
		ownedSession.current = id;
	}, []);
	return { signal, accept };
}
