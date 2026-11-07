import type { SqliteStore } from "../../../infrastructure/sqlite";
import { headWithin } from "../../../infrastructure/context-budget";
import {
	formatResourceUri,
	type ResourceAdapter,
	type ResourceRef,
} from "../../resources";
import { row, list, type Workspace } from "../repository";

export function createMarkdownResourceAdapter(
	store: SqliteStore,
): ResourceAdapter {
	const ref = (value: Workspace): ResourceRef => ({
		uri: formatResourceUri("markdown.document", value.id),
		kind: "markdown.document",
		label: [...value.title].slice(0, 120).join(""),
		createdAt: new Date(value.created_at).toISOString(),
	});
	return {
		kind: "markdown.document",
		fromResultInTransaction(db, result) {
			if (!result || typeof result !== "object") return [];
			const r = result as { documentId?: string; savedRef?: string };
			const value = row(db, r.documentId ?? r.savedRef ?? "");
			return value ? [ref(value)] : [];
		},
		getInTransaction(db, id) {
			const value = row(db, id);
			return value
				? {
						...ref(value),
						adapterRef: "adapter:markdown@1",
						targetRef: id,
						actions: ["open", "read"],
						preview: value.source_id
							? "Docling Deskの文書（作業中の変更を含む）"
							: "作業用下書き",
					}
				: null;
		},
		async search(query) {
			return store
				.read((db) => list(db).map((item) => row(db, item.id)!))
				.filter(
					(value) =>
						(!query.text || value.title.includes(query.text)) &&
						(!query.since || value.updated_at >= Date.parse(query.since)) &&
						(!query.until || value.updated_at <= Date.parse(query.until)),
				)
				.slice(0, query.limit)
				.map(ref);
		},
		async read(id) {
			const value = store.read((db) => row(db, id));
			if (!value) throw new Error("item_not_found");
			return {
				text: headWithin(
					JSON.stringify({
						title: value.title,
						revision: value.revision,
						storage: value.source_id ? "Docling Desk" : "draft",
						document: JSON.parse(value.content_json),
					}),
					560,
					"…（以下省略）",
				).text,
			};
		},
	};
}
