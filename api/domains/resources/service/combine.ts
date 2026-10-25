import type { ResourceAdapter, ResourceRef } from "../contracts";

const newestFirst = (a: ResourceRef, b: ResourceRef) =>
	Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
	(a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0);

/**
 * One kind owned by several domains (`code.task`: codex-tasks, kanban, shell). Each part keeps to its own
 * ids, written `<prefix>:<owner id>` and understood by the part itself; this only routes by that prefix.
 */
export function combineKindAdapters(
	kind: string,
	parts: ReadonlyArray<{ prefix: string; adapter: ResourceAdapter }>,
): ResourceAdapter {
	const partOf = (id: string) => {
		const found = parts.find(({ prefix }) => id.startsWith(`${prefix}:`));
		if (!found) throw new Error("item_not_found");
		return found.adapter;
	};
	return {
		kind,
		fromResultInTransaction: (db, result, context) =>
			parts.flatMap(({ adapter }) =>
				adapter.fromResultInTransaction(db, result, context),
			),
		getInTransaction(db, id) {
			const found = parts.find(({ prefix }) => id.startsWith(`${prefix}:`));
			return found ? found.adapter.getInTransaction(db, id) : null;
		},
		async search(query, signal) {
			const lists = await Promise.allSettled(
				parts.map(({ adapter }) => adapter.search(query, signal)),
			);
			signal.throwIfAborted();
			return lists
				.flatMap((list) => (list.status === "fulfilled" ? list.value : []))
				.sort(newestFirst)
				.slice(0, query.limit);
		},
		read: (id, signal) => partOf(id).read(id, signal),
		prepareInTransaction(db, id, action, context) {
			const part = partOf(id);
			if (part.prepareInTransaction)
				return part.prepareInTransaction(db, id, action, context);
			const view = part.getInTransaction(db, id);
			if (!view) throw new Error("item_not_found");
			return { adapterRef: view.adapterRef, targetRef: view.targetRef };
		},
	};
}
