import type {
	Drawing,
	DrawingSession,
	Reference,
	Scene,
} from "../api/domains/excalidraw/contracts";
import type { Transport } from "./transport";
import { json } from "./transport";
export function excalidrawClient(t: Transport) {
	const path = (id: string) =>
		`/api/excalidraw/sessions/${encodeURIComponent(id)}`;
	return {
		drawingReferences: async (
			conversationId = "main",
			signal?: AbortSignal,
		): Promise<Reference[]> =>
			(
				await t.call(
					`/api/excalidraw/references?conversationId=${encodeURIComponent(conversationId)}`,
					{ signal },
				)
			).json(),
		drawingOperations: async (
			signal?: AbortSignal,
		): Promise<
			Array<{
				id: string;
				state: string;
				runId: string;
				action: string | null;
				referenceId: string | null;
				sessionId: string | null;
				url: string | null;
			}>
		> => (await t.call("/api/excalidraw/operations", { signal })).json(),
		openDrawing: async (
			input: {
				requestId: string;
				referenceId?: string;
				revision?: number;
				title?: string;
				conversationId?: string;
			},
			signal?: AbortSignal,
		): Promise<DrawingSession> =>
			(
				await t.call("/api/excalidraw/sessions", { ...json(input), signal })
			).json(),
		drawingSession: async (
			id: string,
			signal?: AbortSignal,
		): Promise<DrawingSession> => (await t.call(path(id), { signal })).json(),
		reconnectDrawing: async (
			id: string,
			signal?: AbortSignal,
		): Promise<DrawingSession> =>
			(await t.call(`${path(id)}/reconnect`, { ...json({}), signal })).json(),
		drawingDocument: async (
			id: string,
			signal?: AbortSignal,
		): Promise<Drawing> =>
			(await t.call(`${path(id)}/document`, { signal })).json(),
		saveDrawing: async (
			id: string,
			input: { title: string; scene: Scene; expectedRevision: number },
			key: string,
		): Promise<Drawing> =>
			(
				await t.call(`${path(id)}/document`, {
					method: "PUT",
					headers: {
						"Content-Type": "application/json",
						"Idempotency-Key": key,
					},
					body: JSON.stringify(input),
				})
			).json(),
		drawingActivity: async (id: string): Promise<void> => {
			await t.call(`${path(id)}/activity`, json({}));
		},
		releaseDrawing: async (id: string): Promise<void> => {
			await t.call(path(id), { method: "DELETE", keepalive: true });
		},
	};
}
