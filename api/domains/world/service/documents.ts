import type { Database } from "bun:sqlite";
import { sha256Hex } from "../../../infrastructure/digest";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	worldDocumentInput,
	worldDocumentsInput,
	type WorldDocumentScope,
} from "../contracts/documents";
import {
	insertDocument,
	readDocument,
	searchDocuments,
	withdrawDocument,
} from "../repository/documents";

/** Host-owned reference material. Import is not extraction, adoption, or verification of external truth. */
export function createWorldDocuments(store: SqliteStore) {
	const api = {
		async import(scope: WorldDocumentScope, raw: unknown) {
			const doc = worldDocumentInput.parse(raw);
			if (
				Buffer.byteLength(doc.content) > 262144 ||
				`sha256:${sha256Hex(doc.content)}` !== doc.digest
			)
				throw new Error("document_digest_mismatch");
			return store.write((db) => {
				const previous = readDocument(db, scope, doc.id);
				if (previous) {
					if (previous.withdrawn) throw new Error("document_withdrawn");
					if (
						Object.entries(doc).some(
							([key, value]) => previous[key as keyof typeof doc] !== value,
						)
					)
						throw new Error("document_revision_conflict");
					return { status: "unchanged" as const };
				}
				insertDocument(db, scope, doc);
				return { status: "inserted" as const };
			});
		},
		withdraw: (scope: WorldDocumentScope, id: string) =>
			store.write((db) => withdrawDocument(db, scope, id)),
		lookupInTransaction(db: Database, scope: WorldDocumentScope, raw: unknown) {
			const input = worldDocumentsInput.parse(raw);
			if (!!input.query === !!input.documentId)
				throw new Error("invalid_input");
			const offset = input.offset ?? 0;
			if (input.query) {
				const found = searchDocuments(db, scope, input.query, offset);
				const documents: Array<{
					id: string;
					title: string;
					collection: string;
				}> = [];
				for (const row of found.slice(0, 10)) {
					const item = {
						id: row.id,
						title: [...row.title].slice(0, 80).join(""),
						collection: [...row.collection].slice(0, 50).join(""),
					};
					if (Buffer.byteLength(JSON.stringify([...documents, item])) > 2400)
						break;
					documents.push(item);
				}
				return {
					kind: "search" as const,
					documents,
					...(found.length > documents.length
						? { nextOffset: offset + documents.length }
						: {}),
				};
			}
			const doc = readDocument(db, scope, input.documentId!);
			if (!doc || doc.withdrawn) throw new Error("not_found");
			const chars = [...doc.content];
			if (offset >= chars.length) throw new Error("invalid_offset");
			// At most 8 KiB even for four-byte characters; boundaries never split a code point.
			const end = Math.min(offset + 2048, chars.length);
			const { content: _content, withdrawn: _withdrawn, ...metadata } = doc;
			return {
				kind: "document" as const,
				...metadata,
				text: chars.slice(offset, end).join(""),
				offset,
				end,
				complete: offset === 0 && end === chars.length,
				...(end < chars.length ? { nextOffset: end } : {}),
			};
		},
		isCurrentInTransaction(
			db: Database,
			scope: WorldDocumentScope,
			id: string,
			revision: string,
		) {
			const doc = readDocument(db, scope, id);
			return !!doc && !doc.withdrawn && doc.revision === revision;
		},
	};
	return {
		...api,
		lookup: (scope: WorldDocumentScope, raw: unknown) =>
			store.readSnapshot((db) => api.lookupInTransaction(db, scope, raw)),
	};
}
export type WorldDocuments = ReturnType<typeof createWorldDocuments>;
