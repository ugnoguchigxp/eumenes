import type { Database } from "bun:sqlite";
import { headWithin } from "../../../infrastructure/context-budget";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	formatResourceUri,
	RESOURCE_LABEL_MAX,
	type ResourceAdapter,
	type ResourceRef,
	type ResourceSearch,
} from "../../resources";
import { formFields } from "../contracts";
import { get, listByCreation, type CompositionRow } from "../repository";
import { parseJson, scope } from "./shared";

/** The UI studio; the target is the saved composition, as the screen's `ui-select` takes it. */
const UI_COMPOSITION_RESOURCE_ADAPTER_REF = "adapter:ui-compositions@1";
const KIND = "ui.composition";
/** A search reads at most this many saved compositions, newest first. */
const SEARCH_WINDOW = 200;
const READ_BUDGET_TOKENS = 560;
const MARK = "…（以下省略）";
/** Parts nested deeper than a valid composition allows are not counted. */
const MAX_DEPTH = 8;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

const titleOf = (row: CompositionRow) => row.title.trim() || "新しいUI";

/** How many parts of each view a definition has (its `layout` parts nest through `children`). */
function viewCounts(
	node: unknown,
	counts = new Map<string, number>(),
	depth = 0,
) {
	if (!isRecord(node) || depth > MAX_DEPTH) return counts;
	if (typeof node.view === "string")
		counts.set(node.view, (counts.get(node.view) ?? 0) + 1);
	if (Array.isArray(node.children))
		for (const child of node.children) viewCounts(child, counts, depth + 1);
	return counts;
}

/**
 * The composition kind (`ui.composition`) over the domain's saved compositions (`ready` rows of the default
 * scope). The id is the composition id. A draft that was never saved is not a resource.
 */
export function createUiCompositionResourceAdapter(deps: {
	store: SqliteStore;
}): ResourceAdapter {
	const { store } = deps;
	const saved = (db: Database, id: string) => {
		const row = get(db, id);
		return row?.scope === scope ? row : null;
	};
	const refOf = (row: CompositionRow): ResourceRef => ({
		uri: formatResourceUri(KIND, row.id),
		kind: KIND,
		label: [...titleOf(row)].slice(0, RESOURCE_LABEL_MAX).join(""),
		createdAt: new Date(row.created_at).toISOString(),
	});
	return {
		kind: KIND,
		/**
		 * `result` is a save receipt (`{ projectId, state: "saved" }`) or a work state (`{ savedRef }`); the
		 * composition must exist now.
		 */
		fromResultInTransaction(db: Database, result: unknown) {
			if (!isRecord(result)) return [];
			const id =
				result.state === "saved" && typeof result.projectId === "string"
					? result.projectId
					: typeof result.savedRef === "string"
						? result.savedRef
						: null;
			const row = id ? saved(db, id) : null;
			return row ? [refOf(row)] : [];
		},
		getInTransaction(db: Database, id: string) {
			const row = saved(db, id);
			return row
				? {
						...refOf(row),
						adapterRef: UI_COMPOSITION_RESOURCE_ADAPTER_REF,
						targetRef: row.id,
						actions: ["open", "read"],
						preview: `版${row.saved_revision}`,
					}
				: null;
		},
		async search(query: ResourceSearch) {
			const words = query.text.split(/\s+/).filter(Boolean);
			const since = query.since ? Date.parse(query.since) : null;
			const until = query.until ? Date.parse(query.until) : null;
			return store
				.read((db) => listByCreation(db, scope, SEARCH_WINDOW))
				.filter((row) => {
					if (since !== null && row.created_at < since) return false;
					if (until !== null && row.created_at > until) return false;
					return words.every((word) => titleOf(row).includes(word));
				})
				.slice(0, query.limit)
				.map(refOf);
		},
		/**
		 * The title, the times and the saved version, the kinds of parts it is made of with their counts, and the
		 * labels of its form fields. The definition itself is never quoted, so nothing is cut; the lists are
		 * limited by count and the whole is held to the budget.
		 */
		async read(id: string) {
			const row = store.read((db) => saved(db, id));
			if (!row) throw new Error("item_not_found");
			const lines = [
				`画面「${[...titleOf(row)].slice(0, RESOURCE_LABEL_MAX).join("")}」（版${row.saved_revision}）`,
				`作成: ${new Date(row.created_at).toISOString()}`,
				`更新: ${new Date(row.updated_at).toISOString()}`,
			];
			const counts = [...viewCounts(parseJson<unknown>(row.definition_json))]
				.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
				.slice(0, 8);
			if (counts.length)
				lines.push(
					`部品: ${counts.map(([view, n]) => `${view}×${n}`).join("、")}`,
				);
			const fields = row.fields_json
				? formFields.safeParse(parseJson<unknown>(row.fields_json))
				: null;
			if (fields?.success && fields.data.length)
				lines.push(
					`入力項目: ${fields.data.map((field) => field.label).join("、")}`,
				);
			return {
				text: headWithin(lines.join("\n"), READ_BUDGET_TOKENS, MARK).text,
			};
		},
	};
}
