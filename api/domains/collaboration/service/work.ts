import type { Database } from "bun:sqlite";
import { withinJsonLimits } from "eumenes-collaboration";
import type { QueueService } from "../../queue";
import type {
	Check,
	ChildView,
	CollaborationKind,
	Ports,
	RejectedDraft,
	WorkKind,
} from "../contracts";
import {
	forSession,
	pending,
	sourceRef,
	sources,
	work,
	type WorkRow,
} from "../repository";
import { createWorkContext, fail, json, terminal } from "./work-context";
import { createChildOperations } from "./work-children";
import { createWorkReviews } from "./work-reviews";

/** Canonical work only. Dialogue owns sessions; existing execution domains own child work. */
export function createCollaborationWorks(
	now: () => number = Date.now,
	queue?: QueueService,
) {
	let ports: Ports | undefined;
	const host = () => ports ?? fail("collaboration_unavailable");
	const context = createWorkContext(host, now, (db, row) =>
		reviews.invalidate(db, row),
	);
	const reviews = createWorkReviews(context, queue);
	const { current, live, held, authority, response, purge } = context;
	function taskTurn(
		db: Database,
		input: { workRef: string; sessionId: string; runId: string },
	) {
		const row = held(db, input.workRef, input.sessionId, input.runId);
		if (row.kind !== "task") fail("work_not_found");
		authority(db, row);
		return row;
	}
	const state = (db: Database, row: WorkRow) => {
		const view = context.state(db, row);
		const review = reviews.view(db, row);
		return {
			...view,
			current: { ...view.current, review },
			context: review
				? {
						...view.context,
						review: {
							revision: review.revision,
							status: review.status,
							summary: "summary" in review ? review.summary : undefined,
						},
					}
				: view.context,
		};
	};
	return {
		configure(value: Ports) {
			ports = value;
		},
		available: (db: Database, kind: CollaborationKind) =>
			ports?.available(db, kind) ?? false,
		review: reviews.start,
		cancelReview: reviews.cancel,
		taskOffers(
			db: Database,
			input: Parameters<typeof taskTurn>[1],
			offers?: readonly string[],
		): string[] {
			const row = taskTurn(db, input);
			if (offers) {
				db.query("UPDATE collaboration_works SET offer_json=? WHERE id=?").run(
					JSON.stringify({ runId: input.runId, offers }),
					row.id,
				);
				return [...offers];
			}
			const saved = row.offer_json && JSON.parse(row.offer_json);
			return saved?.runId === input.runId ? saved.offers : [];
		},
		open(
			db: Database,
			kind: WorkKind,
			sessionId: string,
			targetRef: string | null,
		) {
			if (targetRef) fail("target_not_found");
			const existing = forSession(db, sessionId);
			if (existing) {
				if (existing.kind !== kind || existing.ended) fail("work_not_found");
				return state(db, existing);
			}
			if (
				db
					.query<{ n: number }, []>(
						"SELECT count(*) AS n FROM collaboration_works",
					)
					.get()!.n >= 128
			)
				fail("collaboration_capacity");
			const id = crypto.randomUUID();
			db.query(
				"INSERT INTO collaboration_works(id,session_id,kind,created_at,updated_at) VALUES(?,?,?,?,?)",
			).run(id, sessionId, kind, now(), now());
			return state(db, work(db, id)!);
		},
		state: (db: Database, id: string) => {
			const row = work(db, id);
			return row && !row.ended ? state(db, row) : null;
		},
		sourceOfTurn(
			db: Database,
			kind: WorkKind,
			id: string,
			sessionId: string,
			runId: string,
		) {
			const row = held(db, id, sessionId, runId);
			if (row.kind !== kind) fail("work_not_found");
			authority(db, row);
			return response(db, row, runId);
		},
		begin(db: Database, id: string, runId: string) {
			const row = live(db, id);
			if (row.busy_run_id && row.busy_run_id !== runId) fail("work_busy");
			const ownerSession = host().authority(db, row.session_id);
			if (!ownerSession?.active) fail("specialist_session_changed");
			if (!row.source_json) {
				const source = host().source(db, runId);
				if (
					!source ||
					source.conversationId !== ownerSession.conversationId ||
					source.specialistSessionId !== row.session_id
				)
					fail("collaboration_source_invalid");
				const { request: _request, ...ref } = source;
				db.query("UPDATE collaboration_works SET source_json=? WHERE id=?").run(
					JSON.stringify(ref),
					id,
				);
			} else current(db, row);
			const actual = host().source(db, runId);
			if (actual) {
				const owner = sourceRef(work(db, id)!)!;
				if (
					actual.conversationId !== owner.conversationId ||
					actual.specialistSessionId !== row.session_id
				)
					fail("collaboration_source_invalid");
				const known = sources(db, id);
				if (
					known.length >= 128 &&
					!known.some((ref) => ref.message_id === actual.messageId)
				)
					fail("collaboration_source_capacity");
				db.query(
					"INSERT OR IGNORE INTO collaboration_sources VALUES(?,?,?,?)",
				).run(id, actual.messageId, runId, actual.digest);
			}
			db.query("UPDATE collaboration_works SET busy_run_id=? WHERE id=?").run(
				runId,
				id,
			);
		},
		release(db: Database, id: string, runId: string) {
			db.query(
				"UPDATE collaboration_works SET busy_run_id=NULL WHERE id=? AND busy_run_id=?",
			).run(id, runId);
		},
		end(db: Database, id: string, mode: "discard" | "close") {
			const row = work(db, id);
			if (!row || row.ended) return;
			if (row.busy_run_id) fail("work_busy");
			if (mode === "close" && state(db, row).dirty) fail("work_unsaved");
			purge(db, row);
		},
		document(db: Database, id: string) {
			const row = work(db, id);
			return row && !row.ended
				? {
						revision: row.revision,
						title: row.title,
						text: JSON.stringify(json(row.document_json), null, 2),
						rejected: json(row.rejected_json) as RejectedDraft | null,
					}
				: null;
		},
		commit(
			db: Database,
			input: {
				workRef: string;
				sessionId: string;
				runId: string;
				baseRevision: number;
				title?: string;
				value: unknown;
			},
		) {
			const row = held(db, input.workRef, input.sessionId, input.runId);
			if (row.kind === "schedule" || row.kind === "task")
				fail("work_not_found");
			if (row.revision !== input.baseRevision) fail("revision_conflict");
			if (row.child_id) {
				const child = host().view(db, row.kind, current(db, row), row.child_id);
				if (!child || !terminal(child) || child.status === "indeterminate")
					fail("work_busy");
			}
			if (
				!withinJsonLimits(input.value) ||
				JSON.stringify(input.value).length > 65536
			)
				fail("collaboration_document_capacity");
			const checked: Check = host().check(
				db,
				row.kind,
				input.value,
				current(db, row),
			);
			if (!checked.ok) fail("collaboration_definition_invalid");
			reviews.invalidate(db, row);
			db.query(
				"UPDATE collaboration_works SET document_json=?,title=?,revision=revision+1,rejected_json=NULL,child_id=NULL,child_epoch=NULL,child_digest=NULL,child_json=NULL,updated_at=? WHERE id=?",
			).run(
				JSON.stringify(checked.value),
				input.title ?? row.title,
				now(),
				row.id,
			);
			return { revision: row.revision + 1 };
		},
		reject(db: Database, id: string, value: RejectedDraft) {
			if (!withinJsonLimits(value)) fail("collaboration_document_capacity");
			db.query("UPDATE collaboration_works SET rejected_json=? WHERE id=?").run(
				JSON.stringify(value),
				live(db, id).id,
			);
		},
		...createChildOperations(context),
		cancel(
			db: Database,
			input: { workRef: string; sessionId: string; runId: string },
		) {
			const row = held(db, input.workRef, input.sessionId, input.runId);
			if (row.kind === "schedule") fail("work_not_found");
			const owner = authority(db, row);
			response(db, row, input.runId);
			if (
				row.kind === "task" &&
				(!row.child_id ||
					row.child_epoch !== owner.epoch ||
					!host().view(db, row.kind, current(db, row), row.child_id))
			)
				fail("collaboration_child_changed");
			if (row.child_id)
				host().cancel(db, row.kind, current(db, row), row.child_id);
		},
		pending: (db: Database, workRef?: string) =>
			pending(db).some((row) => workRef === undefined || row.id === workRef),
		read: (db: Database, id: string) => work(db, id),
		report(db: Database, id: string) {
			const row = work(db, id);
			if (!row || row.ended || !row.child_id) return null;
			current(db, row);
			return host().report?.(db, row.session_id, row.child_id) ?? null;
		},
		ownsChild(db: Database, childId: string, conversationId: string) {
			return !!db
				.query(
					"SELECT 1 FROM collaboration_works WHERE ended=0 AND child_id=? AND json_extract(source_json,'$.conversationId')=?",
				)
				.get(childId, conversationId);
		},
		receipt(db: Database, requestId: string, kind: CollaborationKind) {
			const found = db
				.query<{ result_json: string }, [string, string]>(
					"SELECT r.result_json FROM collaboration_receipts r JOIN collaboration_works w ON w.id=r.work_id WHERE r.request_id=? AND w.kind=?",
				)
				.get(requestId, kind);
			return found ? (JSON.parse(found.result_json) as ChildView) : null;
		},
		view(
			db: Database,
			kind: CollaborationKind,
			conversationId: string,
			workRef?: string,
		) {
			const row = workRef
				? work(db, workRef)
				: db
						.query<WorkRow, [string, string]>(
							"SELECT * FROM collaboration_works WHERE ended=0 AND kind=? AND json_extract(source_json,'$.conversationId')=? ORDER BY created_at DESC LIMIT 1",
						)
						.get(kind, conversationId);
			if (
				!row ||
				row.ended ||
				row.kind !== kind ||
				sourceRef(row)?.conversationId !== conversationId
			)
				return null;
			return { ...state(db, row), document: json(row.document_json) };
		},
		forget(db: Database, messageIds: readonly string[]) {
			const ids = new Set(messageIds);
			for (const row of db
				.query<WorkRow, []>("SELECT * FROM collaboration_works")
				.all())
				if (sources(db, row.id).some((ref) => ids.has(ref.message_id)))
					purge(db, row, true);
		},
	};
}
