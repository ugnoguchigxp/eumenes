import { z } from "zod";
import { drawingDocuments } from "./documents";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { documentSchema, openDrawing, type DrawingSession } from "../contracts";
import {
	getSession,
	updateSession,
	references,
	reference,
	saveReference,
} from "../repository";
import { drawingConnection, type DrawingConnection } from "./connection";
export function createExcalidraw(deps: {
	store: SqliteStore;
	connection: () => DrawingConnection;
	webOrigin: string;
	idleMs?: number;
	pollMs?: number;
	clock?: () => number;
	fetch?: typeof fetch;
}) {
	const { store } = deps,
		clock = deps.clock ?? Date.now;
	const connection = drawingConnection(deps.connection, deps),
		opening = new Map<string, Promise<void>>(),
		aborts = new Map<string, AbortController>();
	let closing = false;
	const get = (id: string) => store.read((db) => getSession(db, id));
	const documents = drawingDocuments(store, connection, clock);
	const publicView = (s: DrawingSession) => ({
		...s,
		url:
			(s.state === "ready" || s.state === "idle") && s.referenceId
				? `${deps.webOrigin}/#drawing/${s.referenceId}?${new URLSearchParams({
						...(s.revision ? { revision: String(s.revision) } : {}),
						...(s.conversationId !== "main"
							? { conversationId: s.conversationId }
							: {}),
					})}`
				: null,
	});
	async function connect(id: string) {
		const existing = opening.get(id);
		if (existing) return existing;
		const s = get(id);
		if (!s || s.state === "closed")
			throw new Error("excalidraw_session_not_found");
		const epoch = s.epoch,
			controller = new AbortController();
		aborts.set(id, controller);
		const task = (async () => {
			try {
				const signal = AbortSignal.any([
					controller.signal,
					AbortSignal.timeout(180000),
				]);
				await connection.ready(id, signal);
				const ref = s.referenceId
					? store.read((db) => reference(db, s.referenceId!))
					: null;
				if (s.referenceId && !ref)
					throw new Error("excalidraw_reference_not_found");
				// A new drawing only holds the lease; the first save creates the upstream document.
				const drawing = ref
					? documentSchema.parse(
							await connection.request(
								id,
								`/api/documents/${ref.documentId}${s.revision ? `?revision=${s.revision}` : ""}`,
								signal,
							),
						)
					: null;
				if (ref && drawing!.id !== ref.documentId)
					throw new Error("excalidraw_document_identity_mismatch");
				await store.write((db) => {
					const current = getSession(db, id);
					if (!current || current.epoch !== epoch || current.state === "closed")
						return;
					if (drawing) saveReference(db, s.conversationId, drawing);
					updateSession(db, id, {
						...(drawing
							? { revision: drawing.revision, title: drawing.title }
							: {}),
						state: "ready",
						errorCode: null,
						lastOperation: clock(),
					});
				});
				if (get(id)?.epoch !== epoch) await connection.release(id);
			} catch (e) {
				await store.write((db) => {
					if (getSession(db, id)?.epoch === epoch)
						updateSession(db, id, {
							state: "failed",
							errorCode:
								e instanceof Error && /^[a-z_0-9]+$/.test(e.message)
									? e.message
									: "excalidraw_start_failed",
						});
				});
			}
		})();
		opening.set(id, task);
		try {
			await task;
		} finally {
			opening.delete(id);
			aborts.delete(id);
		}
	}
	async function session(raw: unknown) {
		if (closing) throw new Error("excalidraw_shutdown");
		const input = openDrawing.parse(raw);
		const id = await store.write((db) => {
			const prior = db
				.query(
					"SELECT id,input_json FROM excalidraw_sessions WHERE request_id=?",
				)
				.get(input.requestId) as { id: string; input_json: string } | null;
			if (prior) {
				if (prior.input_json !== JSON.stringify(input))
					throw new Error("excalidraw_request_conflict");
				return prior.id;
			}
			const ref = input.referenceId ? reference(db, input.referenceId) : null;
			if (
				input.referenceId &&
				(!ref || ref.conversationId !== input.conversationId)
			)
				throw new Error("excalidraw_reference_not_found");
			const id = crypto.randomUUID();
			const s: DrawingSession = {
				id,
				referenceId: ref?.id ?? null,
				conversationId: input.conversationId,
				title: ref?.title ?? input.title,
				state: "starting",
				errorCode: null,
				revision: input.revision ?? null,
				url: null,
				epoch: 0,
				lastOperation: clock(),
			};
			db.query("INSERT INTO excalidraw_sessions VALUES(?,?,?,?)").run(
				id,
				input.requestId,
				JSON.stringify(input),
				JSON.stringify(s),
			);
			return id;
		});
		if (get(id)?.state === "starting") void connect(id);
		return publicView(get(id)!);
	}
	async function reconnect(id: string) {
		if (get(id)?.state === "starting") return publicView(get(id)!);
		aborts.get(id)?.abort();
		await opening.get(id);
		await connection.reset(id);
		await store.write((db) => {
			const s = getSession(db, id);
			if (!s || s.state === "closed")
				throw new Error("excalidraw_session_not_found");
			updateSession(db, id, {
				state: "starting",
				errorCode: null,
				lastOperation: clock(),
				epoch: s.epoch + 1,
			});
		});
		void connect(id);
		return publicView(get(id)!);
	}

	async function wait(id: string) {
		await opening.get(id);
		return get(id) ? publicView(get(id)!) : null;
	}
	async function release(id: string) {
		await store.write((db) => {
			const s = getSession(db, id);
			if (s)
				updateSession(db, id, {
					state: "closed",
					url: null,
					epoch: s.epoch + 1,
				});
		});
		aborts.get(id)?.abort();
		await connection.release(id);
	}
	/** A new drawing link opens a local editor; nothing is stored upstream until its first save. */
	function draftUrl(conversationId: string, title: string) {
		return `${deps.webOrigin}/#drawing/new/${crypto.randomUUID()}?${new URLSearchParams(
			{
				title,
				...(conversationId !== "main" ? { conversationId } : {}),
			},
		)}`;
	}
	/** Deletes the upstream document first; the reference goes only after that is confirmed. */
	async function remove(referenceId: string, conversationId: string) {
		const ref = store.read((db) => reference(db, referenceId));
		if (!ref || ref.conversationId !== conversationId)
			throw new Error("excalidraw_reference_not_found");
		const s = await session({
			requestId: crypto.randomUUID(),
			conversationId,
			title: ref.title,
		});
		try {
			const ready = await wait(s.id);
			if (ready?.state !== "ready") throw new Error("excalidraw_start_failed");
			try {
				const result = z
					.object({ id: z.uuid(), deleted: z.literal(true) })
					.parse(
						await connection.request(
							s.id,
							`/api/documents/${ref.documentId}`,
							AbortSignal.timeout(180000),
							{ method: "DELETE" },
						),
					);
				if (result.id !== ref.documentId)
					throw new Error("excalidraw_document_identity_mismatch");
			} catch (e) {
				if (!(e instanceof Error && e.message === "excalidraw_http_404"))
					throw e;
				// A host without the delete route also answers 404; only a document
				// that cannot be read any more counts as already deleted.
				const gone = await connection
					.request(
						s.id,
						`/api/documents/${ref.documentId}`,
						AbortSignal.timeout(180000),
					)
					.then(
						() => false,
						(error) =>
							error instanceof Error && error.message === "excalidraw_http_404",
					);
				if (!gone) throw new Error("excalidraw_delete_unsupported");
			}
			// Editors still open on the drawing lose their sessions; their unsaved work stays in drafts.
			const open = store.read(
				(db) =>
					db
						.query(
							"SELECT id FROM excalidraw_sessions WHERE json_extract(record_json,'$.referenceId')=? AND json_extract(record_json,'$.state')<>'closed'",
						)
						.all(ref.id) as { id: string }[],
			);
			await store.write((db) =>
				db.query("DELETE FROM excalidraw_references WHERE id=?").run(ref.id),
			);
			for (const { id } of open) await release(id);
		} finally {
			await release(s.id);
		}
	}
	return {
		session,
		reconnect,
		remove,
		draftUrl,
		wait,
		get: (id: string) => {
			const s = get(id);
			return s ? publicView(s) : null;
		},
		list: (conversationId: string) =>
			store.read((db) => references(db, conversationId)),
		...documents,
		async activity(id: string) {
			const s = get(id);
			if (!s || s.state === "closed")
				throw new Error("excalidraw_session_not_found");
			await connection.activity(id);
			await store.write((db) => {
				if (getSession(db, id)?.epoch === s.epoch)
					updateSession(db, id, { state: "ready", lastOperation: clock() });
			});
			return get(id);
		},
		release,
		async tick() {
			for (const id of await connection.tick())
				await store.write((db) => {
					if (getSession(db, id)?.state === "ready")
						updateSession(db, id, { state: "idle", url: null });
				});
		},
		async recover() {
			await store.write((db) => {
				const rows = db.query("SELECT id FROM excalidraw_sessions").all() as {
					id: string;
				}[];
				for (const { id } of rows) {
					const s = getSession(db, id)!;
					if (s.state !== "closed")
						updateSession(db, id, {
							state: "idle",
							url: null,
							epoch: s.epoch + 1,
						});
				}
			});
		},
		async close() {
			closing = true;
			for (const a of aborts.values()) a.abort();
			await connection.close();
			await Promise.allSettled(opening.values());
		},
	};
}
export type ExcalidrawService = ReturnType<typeof createExcalidraw>;
