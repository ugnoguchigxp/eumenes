import { expect, test, vi } from "vitest";
import type { EumenesClient } from "../../../../client";
import type { DrawingSession } from "../../../../api/domains/excalidraw/contracts";
import { reconnectDrawingSession } from "./editor-session";
test("a late accepted session is released after the editor lifetime is cancelled", async () => {
	const abort = new AbortController();
	const next = { id: crypto.randomUUID(), state: "ready" } as DrawingSession;
	let finish!: (session: DrawingSession) => void;
	const releaseDrawing = vi.fn(async () => {}),
		accepted = vi.fn();
	const client = {
		openDrawing: vi.fn(
			() =>
				new Promise<DrawingSession>((resolve) => {
					finish = resolve;
				}),
		),
		releaseDrawing,
	} as unknown as EumenesClient;
	const task = reconnectDrawingSession(
		client,
		{ state: "closed" } as DrawingSession,
		{ referenceId: crypto.randomUUID(), conversationId: "main" },
		abort.signal,
		accepted,
	);
	abort.abort();
	finish(next);
	await expect(task).rejects.toThrow();
	expect(releaseDrawing).toHaveBeenCalledWith(next.id);
	expect(accepted).not.toHaveBeenCalled();
});
