import type { SqliteStore } from "../../../infrastructure/sqlite";
import { documentSchema, documentMetadata, saveDrawing } from "../contracts";
import { getSession, updateSession, reference } from "../repository";
import type { drawingConnection } from "./connection";
export function drawingDocuments(
	store: SqliteStore,
	connection: ReturnType<typeof drawingConnection>,
	clock: () => number,
) {
	const get = (id: string) => store.read((db) => getSession(db, id));
	async function document(id: string, signal: AbortSignal) {
		const s = get(id);
		if (!s || s.state === "closed" || !s.referenceId)
			throw new Error("excalidraw_session_not_found");
		const ref = store.read((db) => reference(db, s.referenceId!))!;
		const doc = documentSchema.parse(
			await connection.request(
				id,
				`/api/documents/${ref.documentId}${s.revision ? `?revision=${s.revision}` : ""}`,
				signal,
			),
		);
		if (
			doc.id !== ref.documentId ||
			(s.revision !== null && doc.revision !== s.revision)
		)
			throw new Error("excalidraw_document_identity_mismatch");
		await store.write((db) => {
			if (getSession(db, id)?.epoch === s.epoch)
				updateSession(db, id, {
					state: "ready",
					errorCode: null,
					lastOperation: clock(),
				});
		});
		if (get(id)?.epoch !== s.epoch)
			throw new Error("excalidraw_connection_invalidated");
		return doc;
	}
	return {
		document,
		async save(id: string, raw: unknown, key: string, signal: AbortSignal) {
			const input = saveDrawing.parse(raw),
				s = get(id);
			if (!s || s.state === "closed" || !s.referenceId)
				throw new Error("excalidraw_session_not_found");
			const ref = store.read((db) => reference(db, s.referenceId!))!;
			try {
				const metadata = documentMetadata.parse(
					await connection.request(
						id,
						`/api/documents/${ref.documentId}`,
						signal,
						{
							method: "PUT",
							headers: {
								"content-type": "application/json",
								"Idempotency-Key": key,
							},
							body: JSON.stringify(input),
						},
					),
				);
				if (
					metadata.id !== ref.documentId ||
					metadata.revision !== input.expectedRevision + 1
				)
					throw new Error("excalidraw_save_unconfirmed");
				const doc = documentSchema.parse(
					await connection.request(
						id,
						`/api/documents/${ref.documentId}?revision=${metadata.revision}`,
						signal,
					),
				);
				if (doc.id !== metadata.id || doc.revision !== metadata.revision)
					throw new Error("excalidraw_save_unconfirmed");
				await store.write((db) => {
					if (getSession(db, id)?.epoch !== s.epoch) return;
					db.query(
						"UPDATE excalidraw_references SET revision=?,title=? WHERE id=? AND revision<=?",
					).run(doc.revision, doc.title, ref.id, doc.revision);
					updateSession(db, id, {
						revision: doc.revision,
						title: doc.title,
						state: "ready",
						errorCode: null,
						lastOperation: clock(),
					});
				});
				if (get(id)?.epoch !== s.epoch)
					throw new Error("excalidraw_connection_invalidated");
				return doc;
			} catch (e) {
				await store.write((db) => {
					if (getSession(db, id)?.epoch === s.epoch)
						updateSession(db, id, { errorCode: "excalidraw_save_failed" });
				});
				throw e;
			}
		},
	};
}
