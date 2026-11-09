import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { canonicalJson, sha256Hex } from "../../../infrastructure/digest";
import type { QueueService } from "../../queue";
import type { ArchivePort } from "../contracts";
import {
	generatedInput,
	type GeneratedHost,
	type GeneratedReceipt,
} from "../contracts/generated";
import {
	generatedRow,
	generatedReceipt,
	generatedValue,
} from "../repository/generated";
import { registerGeneratedJob, frozenGenerated } from "./generated-job";
import { confirmSave } from "./archive-save";

export function createGeneratedDocuments(
	store: SqliteStore,
	queue: QueueService,
	archive: ArchivePort,
	publish?: () => void,
) {
	let host: GeneratedHost | undefined;
	const owners = new Map<string, GeneratedHost>();
	const hostFor = (ownerRef: string) =>
		owners.get(ownerRef.slice(0, ownerRef.indexOf(":"))) ?? host;
	const aborted = new Set<string>();
	registerGeneratedJob(store, queue, archive, hostFor, publish);
	return {
		flush() {
			queue.flushCancellations([...aborted]);
			aborted.clear();
		},
		async reconcile(id: string, signal: AbortSignal) {
			const r = store.read((db) => generatedRow(db, id));
			if (!r || r.state === "pending") throw new Error("markdown_not_found");
			if (
				generatedReceipt(r).archive.state !== "unknown" ||
				r.binding !== archive.binding()
			)
				return generatedReceipt(r);
			const result = await confirmSave(archive, frozenGenerated(r), signal);
			return store.write((db) => {
				const current = generatedRow(db, id);
				if (
					!current ||
					current.digest !== r.digest ||
					archive.binding() !== r.binding
				)
					throw new Error("markdown_archive_unavailable");
				const value: GeneratedReceipt["archive"] = result.ok
					? { state: "saved", sourceId: result.entry.sourceId }
					: { state: result.state, code: result.code };
				db.query("UPDATE markdown_generated SET archive_json=? WHERE id=?").run(
					JSON.stringify(value),
					id,
				);
				return generatedReceipt(generatedRow(db, id)!);
			});
		},
		configure(value: GeneratedHost) {
			host = value;
		},
		configureOwner(prefix: string, value: GeneratedHost) {
			if (owners.has(prefix))
				throw new Error("markdown_owner_already_registered");
			owners.set(prefix, value);
		},
		localPreviewInTransaction(db: Database, id: string) {
			const r = generatedRow(db, id);
			if (
				!r ||
				r.state !== "settled" ||
				generatedReceipt(r).local.state !== "saved" ||
				!hostFor(generatedValue(r).ownerRef)?.hasLocal(id)
			)
				return null;
			const { title, markdown } = generatedValue(r);
			return { title, markdown };
		},
		startInTransaction(db: Database, raw: unknown): GeneratedReceipt {
			const input = generatedInput.parse(raw);
			if (Buffer.byteLength(input.markdown) > 1_048_576)
				throw new Error("markdown_document_too_large");
			const digest = sha256Hex(
					canonicalJson(input, { omitUndefined: true, keyOrder: "codeUnit" }),
				),
				old = generatedRow(db, input.id);
			if (old) {
				if (old.digest !== digest) throw new Error("request_conflict");
				return generatedReceipt(old);
			}
			if (
				!hostFor(input.ownerRef)?.validInTransaction(
					db,
					input.id,
					input.ownerRef,
				)
			)
				throw new Error("markdown_source_invalid");
			const binding = archive.binding();
			const { job } = queue.enqueueInTransaction(db, {
				scope: "markdown",
				kind: "markdown.generated",
				dedupeKey: input.id,
				payload: { id: input.id },
				subjectRef: input.id,
				lane: "background",
				concurrencyKey: `markdown-generated:${binding}:${input.namespace}`,
				maxAttempts: 1,
				deadlineAtMs: Date.now() + 200000,
			});
			db.query(
				"INSERT INTO markdown_generated VALUES(?,?,?,?,?,'pending',?,?,?,?)",
			).run(
				input.id,
				digest,
				JSON.stringify(input),
				binding,
				`wiki-${input.id.replaceAll("-", "")}`,
				JSON.stringify({ state: "failed", code: "scratch_not_written" }),
				JSON.stringify({ state: "unsaved", code: "markdown_not_saved" }),
				job.id,
				Date.now(),
			);
			return generatedReceipt(generatedRow(db, input.id)!);
		},
		normalizeInterruptedInTransaction(db: Database, id: string) {
			const row = generatedRow(db, id);
			if (!row || row.state !== "pending") return;
			const job = queue.getInTransaction(db, row.job_id);
			if (!job || !["queued", "running", "retry_wait"].includes(job.state))
				db.run(
					"UPDATE markdown_generated SET state='settled' WHERE id=? AND state='pending'",
					[id],
				);
		},
		currentInTransaction(db: Database, id: string): GeneratedReceipt | null {
			const r = generatedRow(db, id);
			if (!r) return null;
			if (r.state === "pending") {
				const job = queue.getInTransaction(db, r.job_id);
				if (!job || !["queued", "running", "retry_wait"].includes(job.state)) {
					// The Queue is authoritative when interruption settled before this owner could adopt.
					r.state = "settled";
				}
			}
			const value = generatedReceipt(r);
			if (archive.binding() !== r.binding)
				value.archive = {
					state: value.archive.state === "unsaved" ? "unsaved" : "unknown",
					code: "markdown_archive_connection_changed",
				};
			if (
				value.local.state === "saved" &&
				!hostFor(generatedValue(r).ownerRef)?.hasLocal(id)
			)
				value.local = { state: "expired", code: "item_not_found" };
			return value;
		},
		cancelInTransaction(db: Database, id: string, forget = false) {
			const r = generatedRow(db, id);
			if (!r) return;
			queue.cancelInTransaction(db, r.job_id, "markdown_source_invalid");
			aborted.add(r.job_id);
			hostFor(generatedValue(r).ownerRef)?.forgetLocal(id);
			if (forget) {
				db.query("DELETE FROM markdown_generated WHERE id=?").run(id);
			} else
				db.query(
					"UPDATE markdown_generated SET state='cancelled' WHERE id=?",
				).run(id);
		},
	};
}
