import type { EumenesClient } from "../../../../client";
import type {
	DrawingSession,
	Scene,
} from "../../../../api/domains/excalidraw/contracts";
export async function waitForDrawing(
	client: EumenesClient,
	s: DrawingSession,
	signal: AbortSignal,
) {
	while (s.state === "starting") {
		signal.throwIfAborted();
		await new Promise((resolve) => setTimeout(resolve, 250));
		s = await client.drawingSession(s.id, signal);
	}
	// A status read may observe idle before the document read. That read ensures its lease.
	if (s.state !== "ready" && s.state !== "idle")
		throw new Error(
			"Excalidrawを起動できませんでした。接続設定を確認して再接続してください。",
		);
	return s;
}
export function downloadScene(value: { scene: Scene } | null) {
	if (!value) return;
	const url = URL.createObjectURL(
		new Blob(
			[
				JSON.stringify({
					type: "excalidraw",
					version: 2,
					source: "eumenes-draft",
					...value.scene,
				}),
			],
			{ type: "application/json" },
		),
	);
	const a = document.createElement("a");
	a.href = url;
	a.download = "drawing.excalidraw";
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A closed browser entry needs a fresh session; reuse the backend reconnect otherwise. */
export async function reconnectDrawingSession(
	client: EumenesClient,
	session: DrawingSession,
	input: { referenceId: string; conversationId: string; revision?: number },
	signal: AbortSignal,
	accepted: (id: string) => void,
) {
	const next =
		session.state === "closed"
			? await client.openDrawing(
					{ ...input, requestId: crypto.randomUUID() },
					signal,
				)
			: await client.reconnectDrawing(session.id, signal);
	try {
		signal.throwIfAborted();
		accepted(next.id);
		const ready = await waitForDrawing(client, next, signal);
		signal.throwIfAborted();
		return ready;
	} catch (error) {
		if (signal.aborted) await client.releaseDrawing(next.id).catch(() => {});
		throw error;
	}
}

/** A new drawing leases LARM only for its first save, which creates the document. */
export async function createDrawingDocument(
	client: EumenesClient,
	options: {
		session: DrawingSession | null;
		conversationId: string;
		input: { title: string; scene: Scene };
		key: string;
		signal: AbortSignal;
		accepted: (id: string) => void;
		ready: (session: DrawingSession) => void;
	},
) {
	const { conversationId, input, signal } = options;
	let s = options.session;
	if (!s || s.state === "closed" || s.state === "failed") {
		const opened = await client.openDrawing(
			{ requestId: crypto.randomUUID(), conversationId, title: input.title },
			signal,
		);
		options.accepted(opened.id);
		try {
			s = await waitForDrawing(client, opened, signal);
		} catch (error) {
			// The next save opens a fresh lease; this one must not linger.
			await client.releaseDrawing(opened.id).catch(() => {});
			throw error;
		}
		options.ready(s);
	}
	const { referenceId, ...doc } = await client.createDrawing(
		s.id,
		input,
		options.key,
		signal,
	);
	// The draft link becomes the saved reference without remounting the editor.
	const url = new URL(window.location.href);
	url.hash = `drawing/${referenceId}?${new URLSearchParams({
		revision: String(doc.revision),
		...(conversationId !== "main" ? { conversationId } : {}),
	})}`;
	window.history.replaceState(window.history.state, "", url);
	return {
		session: { ...s, referenceId, revision: doc.revision },
		referenceId,
		doc,
	};
}
