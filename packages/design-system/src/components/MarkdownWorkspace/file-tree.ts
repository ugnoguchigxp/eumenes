import type { MarkdownLibraryEntry } from "./types";
export type FolderLocation = { namespace: string; path: string };
export type DocumentFolder = FolderLocation & {
	key: string;
	name: string;
	children: DocumentFolder[];
};
export const folderKey = (location: FolderLocation) =>
	JSON.stringify([location.namespace, location.path]);
export const parentPath = (path: string) =>
	path.split("/").slice(0, -1).join("/");
const compare = (a: string, b: string) =>
	a.localeCompare(b, "ja", { numeric: true });
export function documentFolders(
	entries: MarkdownLibraryEntry[],
	namespaces: string[],
): DocumentFolder[] {
	const nodes = new Map<string, DocumentFolder>();
	const roots: DocumentFolder[] = [];
	for (const namespace of new Set([
		...namespaces,
		...entries.map((e) => e.namespace),
	])) {
		const root = {
			namespace,
			path: "",
			key: folderKey({ namespace, path: "" }),
			name: namespace,
			children: [],
		};
		nodes.set(root.key, root);
		roots.push(root);
	}
	for (const entry of entries) {
		let parent = nodes.get(
			folderKey({ namespace: entry.namespace, path: "" }),
		)!;
		for (const part of entry.path.split("/").slice(0, -1)) {
			const path = parent.path ? parent.path + "/" + part : part,
				key = folderKey({ namespace: entry.namespace, path });
			let node = nodes.get(key);
			if (!node) {
				node = {
					namespace: entry.namespace,
					path,
					key,
					name: part,
					children: [],
				};
				nodes.set(key, node);
				parent.children.push(node);
			}
			parent = node;
		}
	}
	const sort = (folders: DocumentFolder[]) => {
		folders.sort((a, b) => compare(a.name, b.name));
		folders.forEach((f) => sort(f.children));
	};
	sort(roots);
	return roots;
}
export function findFolder(
	roots: DocumentFolder[],
	location: FolderLocation,
): DocumentFolder | undefined {
	for (const folder of roots) {
		if (folder.key === folderKey(location)) return folder;
		const found = findFolder(folder.children, location);
		if (found) return found;
	}
	return undefined;
}
export function folderFiles(
	entries: MarkdownLibraryEntry[],
	location: FolderLocation | null,
	query: string,
) {
	const q = query.toLocaleLowerCase();
	return entries
		.filter((entry) => {
			if (location && entry.namespace !== location.namespace) return false;
			const parent = parentPath(entry.path);
			if (
				location &&
				(q
					? location.path &&
						parent !== location.path &&
						!parent.startsWith(location.path + "/")
					: parent !== location.path)
			)
				return false;
			return (
				!q || (entry.title + "\n" + entry.path).toLocaleLowerCase().includes(q)
			);
		})
		.sort((a, b) => compare(a.title, b.title) || compare(a.path, b.path));
}
