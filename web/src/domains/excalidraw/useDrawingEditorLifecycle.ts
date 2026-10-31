import { useCallback, useEffect, useRef } from "react";
import type { EumenesClient } from "../../../../client";
import type {
	Drawing,
	DrawingSession,
} from "../../../../api/domains/excalidraw/contracts";
import {
	capacityBusyOf,
	capacityTimeoutMessage,
	type createCapacityWait,
} from "../../hooks/capacity-wait";
import { waitForDrawing } from "./editor-session";
export function useDrawingEditorLifecycle(options: {
	client: EumenesClient;
	/** Null for a new drawing: no lease until its first save. */
	referenceId: string | null;
	revision?: number;
	conversationId: string;
	/** The one timer that starts the connection again after LARM had no free memory. */
	wait: ReturnType<typeof createCapacityWait>;
	onWaiting: () => void;
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
		const start = async (id: string) => {
			try {
				const s = await client.openDrawing(
					{
						requestId: crypto.randomUUID(),
						referenceId: id,
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
				if (abort.signal.aborted) return;
				callbacks.current.wait.reset();
				callbacks.current.onReady(ready, doc);
			} catch (error) {
				if (abort.signal.aborted) return;
				const busy = capacityBusyOf(error);
				if (busy) {
					// The refused session holds no lease; the next try opens a new one.
					const refused = ownedSession.current;
					ownedSession.current = null;
					if (refused) await client.releaseDrawing(refused).catch(() => {});
					if (abort.signal.aborted) return;
					if (
						callbacks.current.wait.refuse(
							busy.retryAfterMs,
							() => void start(id),
						) === "waiting"
					)
						callbacks.current.onWaiting();
					else callbacks.current.onError(capacityTimeoutMessage);
					return;
				}
				callbacks.current.wait.reset();
				callbacks.current.onError(
					error instanceof Error ? error.message : "接続できませんでした。",
				);
			}
		};
		if (referenceId) void start(referenceId);
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
			// While LARM has no free memory only the wait timer connects again.
			if (event.persisted && !callbacks.current.wait.waiting())
				void callbacks.current.onResume();
		};
		window.addEventListener("pagehide", hide);
		window.addEventListener("pageshow", show);
		window.addEventListener("beforeunload", before);
		return () => {
			abort.abort();
			callbacks.current.wait.reset();
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
