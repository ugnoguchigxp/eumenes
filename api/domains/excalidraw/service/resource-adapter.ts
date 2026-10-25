import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	formatResourceUri,
	RESOURCE_LABEL_MAX,
	type ResourceAdapter,
	type ResourceRef,
	type ResourceSearch,
} from "../../resources";
import { drawingEntries, drawingEntry, type DrawingEntry } from "../repository";

/**
 * The drawing screen. Its target is the reference id, the one the editor link carries
 * (`#drawing/<referenceId>`); the Web adapter that opens it is still to be registered (plan section 9).
 */
const DRAWING_RESOURCE_ADAPTER_REF = "adapter:excalidraw@1";
const KIND = "drawing";
/** A search reads at most this many drawings, newest saved first. */
const SEARCH_WINDOW = 200;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

const titleOf = (entry: DrawingEntry) => entry.title.trim() || "無題の図";
const atOf = (entry: DrawingEntry) => new Date(entry.at ?? 0).toISOString();

/**
 * The drawing kind (`drawing`) over the domain's saved drawing references of one conversation (the one the
 * editor opens them in). The id is the reference id. The scene itself is kept upstream, so `read` states only
 * what the domain holds.
 */
export function createDrawingResourceAdapter(deps: {
	store: SqliteStore;
	conversationId: string;
}): ResourceAdapter {
	const { store, conversationId } = deps;
	const refOf = (entry: DrawingEntry): ResourceRef => ({
		uri: formatResourceUri(KIND, entry.id),
		kind: KIND,
		label: [...titleOf(entry)].slice(0, RESOURCE_LABEL_MAX).join(""),
		createdAt: atOf(entry),
	});
	return {
		kind: KIND,
		/** `result` is the drawing operation's record (`{ state: "completed", referenceId }`); the reference must exist. */
		fromResultInTransaction(db: Database, result: unknown) {
			if (
				!isRecord(result) ||
				result.state !== "completed" ||
				typeof result.referenceId !== "string"
			)
				return [];
			const entry = drawingEntry(db, conversationId, result.referenceId);
			return entry ? [refOf(entry)] : [];
		},
		getInTransaction(db: Database, id: string) {
			const entry = drawingEntry(db, conversationId, id);
			return entry
				? {
						...refOf(entry),
						adapterRef: DRAWING_RESOURCE_ADAPTER_REF,
						targetRef: entry.id,
						actions: ["open", "read"],
						preview: `版${entry.revision}`,
					}
				: null;
		},
		async search(query: ResourceSearch) {
			const words = query.text.split(/\s+/).filter(Boolean);
			const since = query.since ? Date.parse(query.since) : null;
			const until = query.until ? Date.parse(query.until) : null;
			return store
				.read((db) => drawingEntries(db, conversationId, SEARCH_WINDOW))
				.filter((entry) => {
					const at = entry.at ?? 0;
					if (since !== null && at < since) return false;
					if (until !== null && at > until) return false;
					return words.every((word) => titleOf(entry).includes(word));
				})
				.slice(0, query.limit)
				.map(refOf);
		},
		/** The title and the saved version; the time is the earliest session's last operation (the domain keeps no other). */
		async read(id: string) {
			const entry = store.read((db) => drawingEntry(db, conversationId, id));
			if (!entry) throw new Error("item_not_found");
			return {
				text: [
					`図「${[...titleOf(entry)].slice(0, RESOURCE_LABEL_MAX).join("")}」（版${entry.revision}）`,
					...(entry.at === null ? [] : [`操作時刻: ${atOf(entry)}`]),
				].join("\n"),
			};
		},
	};
}
