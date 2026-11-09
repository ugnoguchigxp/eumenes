import { useRef, useState, type DragEvent } from "react";
import { folderKey, type FolderLocation } from "./file-tree";
import { canMoveLibraryItems } from "./library-actions";
import type {
	LibraryFeatures,
	LibraryFiles,
	LibraryItem,
} from "./library-types";

const moveType = "application/x-eumenes-library-move";

export function useLibraryMoveDrag(input: {
	files: LibraryFiles | undefined;
	features: LibraryFeatures;
	disabled: boolean;
	selected: LibraryItem[];
	onMove(files: LibraryFiles, items: LibraryItem[], destination: string): void;
}) {
	const { files, features, disabled, selected } = input;
	const active = useRef<{
		files: LibraryFiles;
		items: LibraryItem[];
		token: string;
	} | null>(null);
	const [hover, setHover] = useState<string>();
	function end() {
		active.current = null;
		setHover(undefined);
	}
	function source(item: LibraryItem) {
		const items = selected.some((entry) => entry.id === item.id)
			? selected
			: [item];
		if (!files || disabled || !canMoveLibraryItems(items, features)) return {};
		return {
			draggable: true,
			onDragStart(event: DragEvent<HTMLElement>) {
				const token = crypto.randomUUID();
				event.dataTransfer.effectAllowed = "move";
				event.dataTransfer.setData(moveType, token);
				active.current = { files, items, token };
			},
		};
	}
	function target(folder: FolderLocation) {
		const key = folderKey(folder);
		function accepted(event: DragEvent<HTMLElement>) {
			const drag = active.current;
			if (
				disabled ||
				!drag ||
				!files ||
				!event.dataTransfer.types.includes(moveType)
			)
				return;
			if (
				files.namespace !== drag.files.namespace ||
				files.path !== drag.files.path ||
				files.etag !== drag.files.etag
			)
				return;
			if (folder.namespace !== files.namespace || folder.path === files.path)
				return;
			if (!canMoveLibraryItems(drag.items, features)) return;
			if (
				drag.items.some(
					(item) =>
						item.kind === "folder" &&
						(folder.path === item.path ||
							folder.path.startsWith(item.path + "/")),
				)
			)
				return;
			return drag;
		}
		return {
			"data-move-target": !disabled && hover === key ? true : undefined,
			onDragOver(event: DragEvent<HTMLElement>) {
				if (!accepted(event)) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "move";
				setHover(key);
			},
			onDragLeave(event: DragEvent<HTMLElement>) {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null))
					setHover((value) => (value === key ? undefined : value));
			},
			onDrop(event: DragEvent<HTMLElement>) {
				const drag = accepted(event);
				end();
				if (!drag || event.dataTransfer.getData(moveType) !== drag.token)
					return;
				event.preventDefault();
				input.onMove(drag.files, drag.items, folder.path);
			},
		};
	}
	return { source, target, end };
}

export type LibraryMoveDrag = ReturnType<typeof useLibraryMoveDrag>;
