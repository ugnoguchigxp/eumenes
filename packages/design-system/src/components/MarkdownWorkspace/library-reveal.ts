import { useEffect, useMemo, useRef, type RefObject } from "react";
import { folderKey, parentPath, type FolderLocation } from "./file-tree";
import type { MarkdownWorkspaceProps } from "./types";

export type RevealRequest = { documentId: string };
export type RevealedDocument = {
	id: string;
	location: FolderLocation | "work" | undefined;
	button: RefObject<HTMLButtonElement | null>;
};

export function useLibraryReveal(
	props: MarkdownWorkspaceProps,
	request?: RevealRequest,
): RevealedDocument | undefined {
	const current =
		props.current?.id === request?.documentId ? props.current : null;
	const sourceId = current?.sourceId;
	const id = sourceId ?? current?.id;
	const saved = sourceId
		? props.library.find((file) => file.sourceId === sourceId)
		: undefined;
	const namespace = current?.remote?.namespace ?? saved?.namespace;
	const path = current?.remote?.path ?? saved?.path;
	const location = useMemo<RevealedDocument["location"]>(() => {
		if (!sourceId) return "work";
		if (namespace && path) return { namespace, path: parentPath(path) };
		return undefined;
	}, [sourceId, namespace, path]);
	const managed = !!props.capabilities?.features?.library;
	const button = useRef<HTMLButtonElement>(null);
	const progress = useRef<{
		request: RevealRequest;
		managed: boolean;
		focused: boolean;
		requested: Set<string>;
	} | null>(null);

	// Loading and focus are tied to a single return to the list. Renders and polls may repeat.
	useEffect(() => {
		if (!request || !id || props.pending) return;
		if (
			progress.current?.request !== request ||
			progress.current.managed !== managed
		)
			progress.current = {
				request,
				managed,
				focused: false,
				requested: new Set(),
			};
		const attempt = progress.current;
		if (attempt.focused) return;
		const node = button.current;
		if (node && !node.disabled && !node.closest("[hidden]")) {
			// Radix switches tabs on pointer down, before the browser focuses the tab.
			const frame = requestAnimationFrame(() => {
				node.focus();
				attempt.focused = node.ownerDocument.activeElement === node;
			});
			return () => cancelAnimationFrame(frame);
		}
		if (!sourceId) return;
		function once(key: string, load: () => void) {
			if (attempt.requested.has(key)) return;
			attempt.requested.add(key);
			load();
		}
		if (managed && namespace && path) {
			if (props.filesLoading || props.filesError || !props.onFiles) return;
			const parent = parentPath(path);
			const folder = folderKey({ namespace, path: parent });
			const page = props.files;
			const sameFolder = page?.namespace === namespace && page.path === parent;
			const firstPageKey = `folder:${folder}`;
			if (!sameFolder || !attempt.requested.has(firstPageKey)) {
				once(firstPageKey, () => props.onFiles?.(namespace, parent));
				return;
			}
			const cursor = page.nextCursor;
			if (cursor)
				once(`files:${folder}:${cursor}`, () =>
					props.onFiles?.(namespace, parent, cursor),
				);
			return;
		}
		if (props.libraryStatus === "loading" || props.libraryStatus === "error")
			return;
		if (props.libraryNextCursor && props.onMore) {
			once(`library:${props.libraryNextCursor}`, props.onMore);
		} else {
			once("library:first", props.onLibrary);
		}
		return undefined;
	});

	if (!request || !id) return;
	return { id, location, button };
}
