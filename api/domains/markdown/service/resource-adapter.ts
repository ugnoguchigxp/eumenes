import { z } from "zod";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { headWithin } from "../../../infrastructure/context-budget";
import {
	formatResourceUri,
	type ResourceAdapter,
	type ResourceRef,
} from "../../resources";
import {
	generatedRow,
	generatedValue,
	generatedReceipt,
} from "../repository/generated";
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
	const generatedRef = (db: import("bun:sqlite").Database, id: string) => {
		const value = generatedRow(db, id);
		if (
			!value ||
			value.state !== "settled" ||
			generatedReceipt(value).archive.state !== "saved"
		)
			return null;
		return {
			uri: formatResourceUri("markdown.document", `generated-${id}`),
			kind: "markdown.document",
			label: [...generatedValue(value).title].slice(0, 120).join(""),
			createdAt: new Date(value.created_at).toISOString(),
		};
	};
	return {
		kind: "markdown.document",
		fromResultInTransaction(db, result, context) {
			if (!result || typeof result !== "object") return [];
			const parsed = z
				.object({
					document: z.object({
						id: z.uuid(),
						title: z.string(),
						path: z.string(),
						archive: z.object({
							state: z.string(),
							sourceId: z.string().optional(),
						}),
					}),
				})
				.safeParse(result);
			if (parsed.success) {
				const output = parsed.data;
				const r = generatedRow(db, output.document.id),
					ref = generatedRef(db, output.document.id);
				if (!r || !ref) return [];
				const input = generatedValue(r),
					saved = generatedReceipt(r);
				return input.conversationId === context.conversationId &&
					input.sourceRunId === context.runId &&
					output.document.title === input.title &&
					output.document.path === input.path &&
					output.document.archive.state === "saved" &&
					output.document.archive.sourceId === saved.archive.sourceId
					? [ref]
					: [];
			}
			const r = result as { documentId?: string; savedRef?: string };
			const value = row(db, r.documentId ?? r.savedRef ?? "");
			return value ? [ref(value)] : [];
		},
		getInTransaction(db, id) {
			if (id.startsWith("generated-")) {
				const ref = generatedRef(db, id.slice("generated-".length));
				return ref
					? {
							...ref,
							adapterRef: "adapter:markdown@1",
							targetRef: id,
							actions: ["open", "read"],
							preview: "Doclingの調査文書",
						}
					: null;
			}
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
			if (id.startsWith("generated-")) {
				const r = store.read((db) =>
					generatedRow(db, id.slice("generated-".length)),
				);
				if (
					!r ||
					r.state !== "settled" ||
					generatedReceipt(r).archive.state !== "saved"
				)
					throw new Error("item_not_found");
				return {
					text: headWithin(
						generatedValue(r).markdown,
						560,
						"…（全文は文書画面で確認できます）",
					).text,
				};
			}
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
