import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { toErrorCode } from "../../../infrastructure/error-code";
import type { QueueService } from "../../queue";
import {
	ArchiveFailure,
	type ArchivePort,
	type ArchiveSave,
} from "../contracts";
import type { GeneratedHost, GeneratedReceipt } from "../contracts/generated";
import {
	generatedRow,
	generatedValue,
	type GeneratedRow,
} from "../repository/generated";
import { assertLibraryIdle } from "../repository/library-operations";
import { archiveDigest } from "./archive-content";
import { confirmSave, executeArchiveSave } from "./archive-save";

export function frozenGenerated(r: GeneratedRow): ArchiveSave {
	const input = generatedValue(r);
	return {
		documentId: r.id,
		sourceId: r.source_id,
		title: input.title,
		markdown: input.markdown,
		recovery: "",
		remoteRevision: null,
		binding: r.binding ?? "",
		namespace: input.namespace,
		path: input.path,
		contentDigest: archiveDigest(input.markdown, ""),
	};
}
export function registerGeneratedJob(
	store: SqliteStore,
	queue: QueueService,
	archive: ArchivePort,
	host: (ownerRef: string) => GeneratedHost | undefined,
	publish?: () => void,
) {
	const valid = (db: Database, r: GeneratedRow) =>
		r.state === "pending" &&
		!!host(generatedValue(r).ownerRef)?.validInTransaction(
			db,
			r.id,
			generatedValue(r).ownerRef,
		);

	function localState(
		db: Database,
		id: string,
		value: GeneratedReceipt["local"],
	) {
		db.query(
			"UPDATE markdown_generated SET local_json=? WHERE id=? AND state='pending'",
		).run(JSON.stringify(value), id);
	}
	queue.registerHandler<
		{ id: string },
		GeneratedRow,
		GeneratedReceipt["archive"]
	>({
		kind: "markdown.generated",
		payloadVersions: [1],
		schema: z.strictObject({ id: z.uuid() }),
		recovery: "interrupt",
		prepareInTransaction(db, claim) {
			const r = generatedRow(db, claim.payload.id);
			if (!r || r.job_id !== claim.jobId || !valid(db, r))
				return { status: "stale", reason: "markdown_source_invalid" };
			return { status: "ready", input: r };
		},
		async execute(r, { signal }) {
			const input = generatedValue(r);
			const assertCurrent = () => {
				signal.throwIfAborted();
				if (
					!store.read((db) => {
						const current = generatedRow(db, r.id);
						return current && valid(db, current);
					})
				)
					throw new Error("markdown_source_invalid");
			};
			assertCurrent();
			try {
				if (!host(input.ownerRef)) throw new Error("scratch_unavailable");
				const uri = await host(input.ownerRef)!.writeLocal(input, signal);
				assertCurrent();
				await store.write((db) =>
					localState(db, r.id, { state: "saved", uri }),
				);
			} catch (e) {
				// A late local write is removed even when cancellation raced its completion.
				if (
					!store.read((db) => {
						const current = generatedRow(db, r.id);
						return current && valid(db, current);
					})
				)
					host(input.ownerRef)?.forgetLocal(r.id);
				await store.write((db) =>
					localState(db, r.id, {
						state: "failed",
						code: toErrorCode(e, "scratch_unavailable"),
					}),
				);
			}
			assertCurrent();
			if (!r.binding || archive.binding() !== r.binding || !archive.available())
				return { state: "unsaved", code: "markdown_archive_unavailable" };
			const previous = JSON.parse(
				r.archive_json,
			) as GeneratedReceipt["archive"];
			// This path also permits bounded read-only reconciliation without a second PUT.
			if (previous.state === "unknown") {
				const result = await confirmSave(archive, frozenGenerated(r), signal);
				return result.ok
					? { state: "saved", sourceId: result.entry.sourceId }
					: { state: result.state, code: result.code };
			}
			try {
				await archive.capabilities(signal);
				const page = await archive.list(signal);
				if (!page.namespaces.includes(input.namespace))
					return { state: "unsaved", code: "markdown_namespace_unavailable" };
				// A document PUT creates its logical parent paths; no folder mutation is required.
				assertCurrent();
				if (archive.binding() !== r.binding)
					return { state: "unsaved", code: "markdown_archive_unavailable" };
				await store.write((db) => {
					const current = generatedRow(db, r.id);
					if (!current || !valid(db, current))
						throw new Error("markdown_source_invalid");
					assertLibraryIdle(db, r.binding, input.namespace);
					db.query(
						"UPDATE markdown_generated SET archive_json=? WHERE id=?",
					).run(
						JSON.stringify({
							state: "unknown",
							code: "markdown_archive_unknown",
						}),
						r.id,
					);
				});
				assertCurrent();
				const outcome = await executeArchiveSave(
					archive,
					frozenGenerated(r),
					signal,
				);
				return outcome.ok
					? { state: "saved", sourceId: outcome.entry.sourceId }
					: { state: outcome.state, code: outcome.code };
			} catch (e) {
				const sent = store.read((db) => generatedRow(db, r.id)?.archive_json);
				return {
					state:
						sent && JSON.parse(sent).state === "unknown"
							? "unknown"
							: "unsaved",
					code:
						e instanceof ArchiveFailure
							? e.code
							: toErrorCode(e, "markdown_archive_unavailable"),
				};
			}
		},
		classify: () => "fail",
		settleInTransaction(db, claim, _input, outcome) {
			const r = generatedRow(db, claim.payload.id);
			if (!r || r.job_id !== claim.jobId || !valid(db, r)) return "stale";
			const value =
				outcome.type === "success" &&
				(!r.binding || archive.binding() === r.binding)
					? outcome.result
					: (JSON.parse(r.archive_json) as GeneratedReceipt["archive"]);
			db.query(
				"UPDATE markdown_generated SET state='settled',archive_json=? WHERE id=?",
			).run(JSON.stringify(value), r.id);
			return "applied";
		},
		cancelInTransaction(db, job) {
			db.query(
				"UPDATE markdown_generated SET state='cancelled' WHERE id=? AND state='pending'",
			).run(job.payload.id);
		},
		afterCommit: publish,
	});
}
