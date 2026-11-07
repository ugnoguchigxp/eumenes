import {
	formatResourceUri,
	type ResourceAdapter,
	type ResourceRef,
	type ResourceView,
} from "../../resources";
import {
	isScratchImage,
	isScratchText,
	SCRATCH_ADAPTER_REF,
	SCRATCH_RESOURCE_KIND,
	type ScratchItem,
} from "../contracts";
import { noteOf, readPage } from "./describe";
import type { ScratchStore } from "./store";

export const scratchUri = (id: string) =>
	formatResourceUri(SCRATCH_RESOURCE_KIND, id);
export const scratchContentUrl = (id: string) =>
	`/api/scratch/${encodeURIComponent(id)}/content`;

const refOf = (item: ScratchItem): ResourceRef => ({
	uri: scratchUri(item.id),
	kind: SCRATCH_RESOURCE_KIND,
	label: item.name,
	createdAt: new Date(item.createdAt).toISOString(),
});

export function scratchView(item: ScratchItem): ResourceView {
	return {
		...refOf(item),
		adapterRef: SCRATCH_ADAPTER_REF,
		targetRef: item.id,
		actions: ["open", "read"],
		preview: isScratchImage(item.mime)
			? scratchContentUrl(item.id)
			: noteOf(item),
		note: noteOf(item),
	};
}

/**
 * The `scratch` kind (§6・§9.2). Nothing creates it from a toolchain's result: the host puts the user's input,
 * and sub-agents name what `scratch.write` returned in `finish.links`.
 */
export function createScratchResourceAdapter(
	store: ScratchStore,
): ResourceAdapter {
	return {
		kind: SCRATCH_RESOURCE_KIND,
		fromResultInTransaction: () => [],
		getInTransaction(_db, id) {
			const item = store.get(id);
			return item ? scratchView(item) : null;
		},
		async search(query) {
			const since = query.since ? Date.parse(query.since) : -Infinity;
			const until = query.until ? Date.parse(query.until) : Infinity;
			return store
				.all()
				.filter(
					(item) =>
						(!query.text || item.name.includes(query.text)) &&
						item.createdAt >= since &&
						item.createdAt <= until,
				)
				.slice(0, query.limit)
				.map(refOf);
		},
		async read(id, _signal, options) {
			const item = store.get(id);
			if (!item) throw new Error("item_not_found");
			if (!isScratchText(item.mime)) {
				store.touch(id);
				return { text: readPage(item, null) };
			}
			const text = new TextDecoder().decode(await store.bytes(id));
			return { text: readPage(item, text, options?.offset) };
		},
	};
}
