import { z } from "zod";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { sha256Hex } from "../../../infrastructure/digest";
import { ImageImportError, type LarmPlayground } from "../../larm";
import type { ImageImportView } from "../contracts";
import { findImport, insertImport, updateImport } from "../repository/imports";
import { imageUploadLimits, prepareImageUpload } from "./prepare-upload";

type Options = {
	store: SqliteStore;
	gateway: () => LarmPlayground;
	principal?: string;
	now?: () => number;
};
export function createImageUpload(options: Options) {
	const { store } = options;
	const principal = options.principal ?? "local";
	const now = options.now ?? Date.now;
	const jobs = new Map<string, Promise<ImageImportView>>();
	const load = (id: string) => {
		const row = store.read((db) => findImport(db, id, principal));
		if (!row) throw new Error("image_import_not_found");
		return { row, view: JSON.parse(row.view_json) as ImageImportView };
	};
	const keep = (view: ImageImportView, attempted = false) =>
		store.write((db) =>
			updateImport(db, view.requestId, principal, view, attempted),
		);
	function serial(id: string, operation: () => Promise<ImageImportView>) {
		const previous = jobs.get(id) ?? Promise.resolve();
		const job = previous.catch(() => {}).then(operation);
		jobs.set(id, job);
		void job
			.finally(() => {
				if (jobs.get(id) === job) jobs.delete(id);
			})
			.catch(() => {});
		return job;
	}
	async function advance(id: string, maySend: boolean, signal: AbortSignal) {
		const { row, view } = load(id);
		if (view.status === "expired") return view;
		if (view.expiresAt <= now())
			return keep({
				...view,
				status: "expired",
				errorCode: "image_import_receipt_expired",
				httpStatus: 410,
			});
		if (view.status === "failed") return view;
		const client = options.gateway().imageImports;
		if (!client || client.identity !== row.connection)
			return keep({
				...view,
				status: "blocked",
				errorCode: "image_import_connection_changed",
				httpStatus: 409,
			});
		let send = !row.attempted && maySend;
		try {
			let result: Awaited<ReturnType<typeof client.read>> | undefined;
			if (!send) {
				try {
					result = await client.read(id, signal);
				} catch (error) {
					if (!(error instanceof ImageImportError) || error.status !== 404)
						throw error;
					if (maySend && row.bytes) send = true;
					else
						return keep({
							...view,
							status: "ready",
							errorCode: "image_import_not_admitted",
							retryAfterMs: 1000,
						});
				}
			}
			if (send) {
				if (!row.bytes) throw new Error("image_import_bytes_unavailable");
				await keep({ ...view, status: "pending", errorCode: undefined }, true);
				result = await client.send(id, row.bytes, signal);
			}
			if (options.gateway().imageImports.identity !== row.connection)
				return keep({
					...view,
					status: "blocked",
					errorCode: "image_import_connection_changed",
					httpStatus: 409,
				});
			if (!result) throw new Error("image_import_unconfirmed");
			const { receipt, retryAfterMs } = result;
			const common = {
				requestId: id,
				createdAt: Date.parse(receipt.createdAt),
				expiresAt: Date.parse(receipt.expiresAt),
				retryAfterMs,
			};
			if (receipt.status === "failed")
				return keep({
					...common,
					status: "failed",
					errorCode: receipt.error.code,
					httpStatus: result.httpStatus,
				});
			if (receipt.status === "succeeded")
				return keep(
					receipt.deleted
						? {
								...common,
								status: "deleted",
								errorCode: "image_import_artifact_deleted",
							}
						: { ...common, status: "succeeded", artifact: receipt.artifact },
				);
			return keep({ ...common, status: "pending" });
		} catch (error) {
			if (options.gateway().imageImports?.identity !== row.connection)
				return keep({
					...view,
					status: "blocked",
					errorCode: "image_import_connection_changed",
					httpStatus: 409,
				});
			if (error instanceof ImageImportError) {
				const status =
					error.status === 410
						? "expired"
						: [400, 413, 415].includes(error.status)
							? "failed"
							: [401, 403, 409].includes(error.status)
								? "blocked"
								: "unknown";
				return keep({
					...view,
					status,
					errorCode: error.code,
					httpStatus: error.status,
					retryAfterMs: error.retryAfterMs,
				});
			}
			return keep({
				...view,
				status: "unknown",
				errorCode: "image_import_unconfirmed",
				retryAfterMs: 1000,
			});
		}
	}
	return {
		async upload(
			id: string,
			file: File,
			signal: AbortSignal,
			expectedConnection?: string,
		) {
			id = z.uuid().parse(id).toLowerCase();
			if (file.size > imageUploadLimits.maxInputBytes)
				throw new Error("image_too_large");
			const raw = new Uint8Array(await file.arrayBuffer());
			const digest = sha256Hex(raw);
			return serial(id, async () => {
				const prior = store.read((db) => findImport(db, id, principal));
				if (prior) {
					if (expectedConnection && prior.connection !== expectedConnection)
						throw new Error("image_import_connection_changed");
					if (prior.original_digest !== digest)
						throw new Error("idempotency_conflict");
					return advance(id, true, signal);
				}
				const client = options.gateway().imageImports;
				if (expectedConnection && client.identity !== expectedConnection)
					throw new Error("image_import_connection_changed");
				const encoded = await prepareImageUpload(raw, file.type, signal);
				if (encoded.bytes.length > 16 * 1024 * 1024)
					throw new Error("image_too_large");
				if (options.gateway().imageImports.identity !== client.identity)
					throw new Error("image_import_connection_changed");
				await store.write((db) =>
					insertImport(db, {
						id,
						principal,
						connection: client.identity,
						digest,
						bytes: encoded.bytes,
						view: {
							requestId: id,
							createdAt: now(),
							expiresAt: now() + 7 * 86400_000,
							retryAfterMs: 1000,
							status: "ready",
						},
					}),
				);
				return advance(id, true, signal);
			});
		},
		read: (id: string, signal: AbortSignal) =>
			serial(z.uuid().parse(id).toLowerCase(), () =>
				advance(id.toLowerCase(), false, signal),
			),
		resume: (id: string, signal: AbortSignal) =>
			serial(z.uuid().parse(id).toLowerCase(), () =>
				advance(id.toLowerCase(), true, signal),
			),
	};
}
