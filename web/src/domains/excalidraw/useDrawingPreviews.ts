import "./asset-path";
import { useEffect, useRef, useState } from "react";
import type { EumenesClient } from "../../../../client";
import type { Reference } from "../../../../api/domains/excalidraw/contracts";
import { waitForDrawing } from "./editor-session";

/** Canonical scenes are read only on an explicit browse gesture; preview sessions always release. */
export function useDrawingPreviews(
	client: EumenesClient,
	references: Reference[],
	enabled: boolean,
) {
	const cached = useRef<Record<string, string>>({});
	const [previews, setPreviews] = useState<Record<string, string>>({});
	useEffect(() => {
		if (!enabled || !references.length) return;
		const abort = new AbortController();
		void (async () => {
			const { exportToBlob } = await import("@excalidraw/excalidraw");
			for (const r of references) {
				const key = `${r.id}:${r.revision}`;
				if (abort.signal.aborted) return;
				if (cached.current[key]) continue;
				let sessionId: string | undefined;
				try {
					const s = await client.openDrawing(
						{
							requestId: crypto.randomUUID(),
							referenceId: r.id,
							revision: r.revision,
							conversationId: r.conversationId,
						},
						abort.signal,
					);
					sessionId = s.id;
					await waitForDrawing(client, s, abort.signal);
					const doc = await client.drawingDocument(s.id, abort.signal);
					const scene = doc.scene as Parameters<typeof exportToBlob>[0];
					const blob = await exportToBlob({
						elements: scene.elements,
						files: scene.files,
						appState: { ...scene.appState, exportBackground: true },
						getDimensions: (width: number, height: number) => ({
							width,
							height,
							scale: Math.min(1, 192 / Math.max(width, height, 1)),
						}),
					});
					const image = await new Promise<string>((resolve, reject) => {
						const reader = new FileReader();
						reader.onload = () => resolve(String(reader.result));
						reader.onerror = () => reject(new Error("preview_unavailable"));
						reader.readAsDataURL(blob);
					});
					if (!abort.signal.aborted) {
						cached.current[key] = image;
						setPreviews({ ...cached.current });
					}
				} catch {
					/* A missing preview never blocks opening the canonical document. */
				} finally {
					if (sessionId) await client.releaseDrawing(sessionId).catch(() => {});
				}
			}
		})().catch(() => {});
		return () => abort.abort();
	}, [client, references, enabled]);
	return previews;
}
