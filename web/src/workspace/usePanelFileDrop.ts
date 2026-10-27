import { useEffect, useRef, useState } from "react";
import type { WorkspaceState } from "./useWorkspace";

/** Images pasted into the page or dropped on the panel are attached to the input; `dragging` is true while a file is over the panel. */
export function usePanelFileDrop(state: WorkspaceState) {
	const panel = useRef<HTMLElement>(null);
	const depth = useRef(0);
	const [dragging, setDragging] = useState(false);
	// The listeners below attach once; they read the latest callbacks through this ref.
	const latest = useRef({
		add: state.attachments.add,
		edit: state.editInput,
	});
	useEffect(() => {
		latest.current = { add: state.attachments.add, edit: state.editInput };
	});
	useEffect(() => {
		function paste(event: ClipboardEvent) {
			const target = document.activeElement;
			if (
				document.querySelector('[role="dialog"][data-state="open"]') ||
				(target !== document.body && !panel.current?.contains(target))
			)
				return;
			const files = Array.from(event.clipboardData?.files ?? []);
			if (!files.length) return;
			event.preventDefault();
			latest.current.add(files);
			const text = event.clipboardData?.getData("text/plain");
			if (text && target instanceof HTMLTextAreaElement) {
				const start = target.selectionStart;
				const end = target.selectionEnd;
				latest.current.edit(
					target.value.slice(0, start) + text + target.value.slice(end),
				);
				requestAnimationFrame(() =>
					target.setSelectionRange(start + text.length, start + text.length),
				);
			}
		}
		const element = panel.current;
		const enter = (e: DragEvent) => {
			if (e.dataTransfer?.types.includes("Files")) {
				e.preventDefault();
				depth.current++;
				setDragging(true);
			}
		};
		const leave = (e: DragEvent) => {
			if (e.dataTransfer?.types.includes("Files") && --depth.current <= 0) {
				depth.current = 0;
				setDragging(false);
			}
		};
		const over = (e: DragEvent) => {
			if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
		};
		const drop = (e: DragEvent) => {
			if (e.dataTransfer?.files.length) {
				e.preventDefault();
				depth.current = 0;
				setDragging(false);
				latest.current.add(Array.from(e.dataTransfer.files));
			}
		};
		document.addEventListener("paste", paste);
		element?.addEventListener("dragenter", enter);
		element?.addEventListener("dragleave", leave);
		element?.addEventListener("dragover", over);
		element?.addEventListener("drop", drop);
		return () => {
			document.removeEventListener("paste", paste);
			element?.removeEventListener("dragenter", enter);
			element?.removeEventListener("dragleave", leave);
			element?.removeEventListener("dragover", over);
			element?.removeEventListener("drop", drop);
		};
	}, []);
	return { panel, dragging };
}
