import { useEffect } from "react";
import type { EumenesClient } from "../../../../client";
import type { DrawingSession } from "../../../../api/domains/excalidraw/contracts";
/** Observing the persisted status never starts the service or renews its lease. */
export function useDrawingSessionStatus(
	client: EumenesClient,
	id: string | undefined,
	receive: (value: DrawingSession) => void,
) {
	useEffect(() => {
		if (!id) return;
		const abort = new AbortController();
		const timer = setInterval(() => {
			void client
				.drawingSession(id, abort.signal)
				.then((value) => {
					if (!abort.signal.aborted) receive(value);
				})
				.catch(() => {});
		}, 2000);
		return () => {
			abort.abort();
			clearInterval(timer);
		};
	}, [client, id, receive]);
}
