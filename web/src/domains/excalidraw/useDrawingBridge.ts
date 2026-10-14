import { useEffect, useRef } from "react";
import type {
	DrawingFrameCommand,
	DrawingFrameState,
} from "@eumenes/design-system";
import type { useDrawingEditor } from "./useDrawingEditor";

/** Only the same-origin parent can command this embedded editor. No secrets cross the bridge. */
export function useDrawingBridge(
	embedded: boolean,
	editor: ReturnType<typeof useDrawingEditor>,
) {
	const { frameId, referenceId } = editor;
	const current = useRef(editor);
	const loaded = !!editor.drawing;
	// A new drawing reports revision 0 until its first save.
	const revision = editor.drawing?.revision || undefined;
	useEffect(() => {
		if (!embedded || !revision || !referenceId) return;
		const url = new URL(window.location.href);
		const [path, query] = url.hash.slice(1).split("?");
		if (path !== `drawing/${referenceId}`) return;
		const context = new URLSearchParams(query);
		context.set("revision", String(revision));
		url.hash = `${path}?${context}`;
		// Updating the confirmed revision must not remount the canvas or fire hashchange.
		window.history.replaceState(window.history.state, "", url);
	}, [embedded, referenceId, revision]);
	useEffect(() => {
		current.current = editor;
	});
	useEffect(() => {
		if (!embedded || window.parent === window) return;
		const state: DrawingFrameState = {
			type: "eumenes:drawing-state",
			referenceId: frameId,
			sessionId: editor.session?.id,
			title: editor.title,
			status: editor.status,
			error: editor.error,
			busy: editor.busy,
			hasDraft: editor.hasDraft,
			dirty: editor.unsaved,
			loaded,
			revision,
		};
		window.parent.postMessage(state, window.location.origin);
	}, [
		embedded,
		frameId,
		editor.session?.id,
		editor.title,
		editor.status,
		editor.error,
		editor.busy,
		editor.hasDraft,
		editor.unsaved,
		revision,
		loaded,
	]);
	useEffect(() => {
		if (!embedded || window.parent === window) return;
		const receive = (event: MessageEvent) => {
			if (
				event.origin !== window.location.origin ||
				event.source !== window.parent
			)
				return;
			const value = event.data as Partial<DrawingFrameCommand> | null;
			if (
				!value ||
				value.type !== "eumenes:drawing-command" ||
				typeof value.requestId !== "string" ||
				value.requestId.length > 64
			)
				return;
			const e = current.current;
			switch (value.action) {
				case "save":
					void e.save();
					break;
				case "reconnect":
					void e.reconnect();
					break;
				case "restore":
					e.restore();
					break;
				case "download":
					e.download();
					break;
				case "title":
					if (typeof value.value === "string" && value.value.length <= 200)
						e.changeTitle(value.value);
					break;
				case "leave":
					void e.leaveFrame().then((allowed) =>
						window.parent.postMessage(
							{
								type: "eumenes:drawing-leave",
								requestId: value.requestId,
								allowed,
							},
							window.location.origin,
						),
					);
					break;
			}
		};
		window.addEventListener("message", receive);
		return () => window.removeEventListener("message", receive);
	}, [embedded]);
}
