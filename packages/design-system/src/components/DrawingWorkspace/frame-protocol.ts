/** Same-origin editor messages contain display state, never scenes or credentials. */
export type DrawingFrameState = {
	type: "eumenes:drawing-state";
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
