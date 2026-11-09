import type { LibraryFeatures, LibraryItem } from "./library-types";
export const pathInFolder = (path: string, folder: string) =>
	[folder, path.split("/").at(-1)].filter(Boolean).join("/");

export function canMoveLibraryItems(
	items: LibraryItem[],
	features: LibraryFeatures,
) {
	return (
		features.patch &&
		items.length > 0 &&
		(items.length === 1 ||
			(features.batch && items.length <= features.maxBatchItems)) &&
		items.every(
			(item) =>
				!item.hasUnsupportedEntries &&
				(item.kind === "document" || features.folders),
		)
	);
}
export const newLibraryId = (kind: "document" | "folder") =>
	`${kind === "document" ? "wiki" : "folder"}-${crypto.randomUUID().replaceAll("-", "").toLowerCase()}`;
export function selectedRoots(items: LibraryItem[]) {
	return items.filter(
		(e) =>
			!items.some(
				(p) =>
					p.id !== e.id &&
					p.kind === "folder" &&
					p.namespace === e.namespace &&
					e.path.startsWith(p.path + "/"),
			),
	);
}
export function affectedDocument(
	items: LibraryItem[],
	sourceId: string | null,
	path?: string | null,
) {
	return items.some(
		(e) =>
			e.id === sourceId ||
			(e.kind === "folder" && !!path && path.startsWith(e.path + "/")),
	);
}
export type LibraryAction =
	"create-folder" | "patch" | "move" | "copy" | "delete";
export const actionLabels: Record<LibraryAction, string> = {
	"create-folder": "フォルダーを作成",
	patch: "名前・タイトルを変更",
	move: "移動",
	copy: "コピー",
	delete: "削除",
};
export function makeLibraryCommand(input: {
	action: LibraryAction;
	items: LibraryItem[];
	namespace: string;
	etag?: string;
	path: string;
	title: string;
	recursive: boolean;
	ids: Record<string, string>;
}) {
	const { action, namespace, etag, path, title, recursive, ids } = input,
		items = selectedRoots(input.items),
		one = items[0];
	if (action === "create-folder")
		return { op: action, id: ids.root, namespace, path };
	if (input.items.length === 1 && one) {
		const base = { kind: one.kind, id: one.id, namespace, etag: one.etag };
		if (action === "patch")
			return {
				op: "patch",
				...base,
				path,
				...(one.kind === "document" ? { title } : {}),
			};
		if (action === "move") return { op: "patch", ...base, path };
		if (action === "copy")
			return { op: "copy", ...base, path, newId: ids[one.id] };
		return {
			op: "delete",
			...base,
			...(one.kind === "folder" ? { recursive } : {}),
		};
	}
	if (!etag) throw new Error("library_etag_required");
	return {
		op: "batch",
		namespace,
		etag,
		action,
		items: items.map((e) => ({
			kind: e.kind,
			id: e.id,
			...(action === "delete"
				? {}
				: {
						path: pathInFolder(e.path, path),
						...(action === "copy" ? { newId: ids[e.id] } : {}),
					}),
		})),
	};
}
