/** Same-origin editor messages contain display state, never scenes or credentials. */
export type DrawingFrameState = {
	type: "eumenes:drawing-state";
	/** The saved reference, or the draft id of a new drawing (no revision yet). */
	referenceId: string;
	sessionId?: string;
	title: string;
	status: string;
	error: string;
	busy: boolean;
	hasDraft: boolean;
	dirty: boolean;
	loaded: boolean;
	revision?: number;
};
export type DrawingFrameCommand = {
	type: "eumenes:drawing-command";
	action: "save" | "reconnect" | "restore" | "download" | "title" | "leave";
	requestId: string;
	value?: string;
};
/**
 * The editor's current same-origin location names it: a saved reference, or a new
 * drawing's draft id. Its first save replaces the draft link without a reload.
 */
export function isDrawingFrameOf(
	frame: HTMLIFrameElement | null | undefined,
	id: string,
) {
	if (!frame) return false;
	let hash: string;
	try {
		const live = frame.contentWindow?.location;
		// Before navigation the frame is about:blank; its requested link is all it can claim.
		hash =
			!live || live.href === "about:blank"
				? new URL(frame.src).hash
				: live.hash;
	} catch {
		return false;
	}
	const path = hash.split("?")[0];
	return path === `#drawing/${id}` || path === `#drawing/new/${id}`;
}
export function isDrawingFrameState(
	value: unknown,
): value is DrawingFrameState {
	if (!value || typeof value !== "object") return false;
	const s = value as Record<string, unknown>;
	return (
		s.type === "eumenes:drawing-state" &&
		typeof s.referenceId === "string" &&
		s.referenceId.length === 36 &&
		(s.sessionId === undefined ||
			(typeof s.sessionId === "string" && s.sessionId.length === 36)) &&
		typeof s.title === "string" &&
		s.title.length <= 200 &&
		typeof s.status === "string" &&
		s.status.length <= 1000 &&
		typeof s.error === "string" &&
		s.error.length <= 2000 &&
		typeof s.busy === "boolean" &&
		typeof s.hasDraft === "boolean" &&
		typeof s.dirty === "boolean" &&
		typeof s.loaded === "boolean" &&
		(s.revision === undefined ||
			(Number.isSafeInteger(s.revision) && Number(s.revision) > 0))
	);
}
