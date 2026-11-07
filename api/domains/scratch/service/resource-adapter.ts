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
import { noteOf, PAGE_WINDOW_BYTES, readPage } from "./describe";
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

const RESULT_URI = /eumenes:\/\/scratch\/([0-9a-f-]{36})/g;
const RESULT_DEPTH = 6;
const RESULT_REFS = 8;

/** The scratch ids written in the strings of a result (nested to a few levels), in order and once each. */
function resultIds(value: unknown, into: Set<string>, depth = 0) {
	if (into.size >= RESULT_REFS) return;
	if (typeof value === "string") {
		for (const [, id] of value.matchAll(RESULT_URI)) into.add(id!);
	} else if (depth < RESULT_DEPTH && value && typeof value === "object")
		for (const item of Object.values(value)) resultIds(item, into, depth + 1);
}

/**
 * The `scratch` kind (§3・§6・§9.2). The host puts the user's input, sub-agents name what `scratch.write`
 * returned in `finish.links`, and a domain's adapter that wraps its result in a shared file (`store.put` with
 * origin `written`) returns its URI in the result: that one is the work's, when it is the same conversation's.
 */
export function createScratchResourceAdapter(
	store: ScratchStore,
): ResourceAdapter {
	return {
		kind: SCRATCH_RESOURCE_KIND,
		fromResultInTransaction(_db, result, context) {
			const ids = new Set<string>();
			resultIds(result, ids);
			return [...ids].slice(0, RESULT_REFS).flatMap((id) => {
				const item = store.get(id);
				return item &&
					item.origin === "written" &&
					item.conversationId === context.conversationId
					? [refOf(item)]
					: [];
			});
		},
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
			const start = Math.min(
				Math.max(0, Math.floor(options?.offset ?? 0)),
				item.bytes,
			);
			const bytes = await store.slice(id, start, start + PAGE_WINDOW_BYTES);
			return { text: readPage(item, { start, bytes }) };
		},
	};
}
