import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { withinJsonLimits } from "eumenes-collaboration";
import type { Authority, ChildView, Ports, Source } from "../contracts";
import { sourceRef, sources, work, type WorkRow } from "../repository";

export const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function fail(code: string): never {
	throw Object.assign(new Error(code), { code });
}
export const json = (text: string | null): unknown =>
	text === null ? null : JSON.parse(text);
export const terminal = (view: ChildView) =>
	view.status !== "running" && view.status !== "waiting_user";

export function createWorkContext(host: () => Ports, now: () => number) {
	function current(db: Database, row: WorkRow): Source {
		const ref = sourceRef(row);
		const source = ref && host().source(db, ref.runId);
		if (
			!source ||
			source.messageId !== ref?.messageId ||
			source.conversationId !== ref.conversationId ||
			source.digest !== ref.digest ||
			source.specialistSessionId !== ref.specialistSessionId
		)
			return fail("collaboration_source_invalid");
		for (const used of sources(db, row.id)) {
			const actual = host().source(db, used.run_id);
			if (
				!actual ||
				actual.messageId !== used.message_id ||
				actual.digest !== used.digest ||
				actual.specialistSessionId !== row.session_id ||
				actual.conversationId !== source.conversationId
			)
				fail("collaboration_source_invalid");
		}
		return source;
	}
	const live = (db: Database, id: string) => {
		const row = work(db, id);
		return row && !row.ended ? row : fail("work_not_found");
	};
	function held(db: Database, id: string, sessionId: string, runId: string) {
		const row = live(db, id);
		if (row.session_id !== sessionId || row.busy_run_id !== runId)
			fail("work_turn_changed");
		current(db, row);
		return row;
	}
	function state(db: Database, row: WorkRow) {
		const source = row.source_json ? current(db, row) : null;
		const child =
			source && row.child_id && row.kind !== "schedule"
				? host().view(db, row.kind, source, row.child_id)
				: null;
		if (child && !withinJsonLimits(child))
			fail("collaboration_result_capacity");
		return {
			workRef: row.id,
			savedRef: null,
			dirty: row.document_json
				? child?.status !== "completed"
				: !!row.child_id &&
					(!child || !terminal(child) || child.status === "indeterminate"),
			busy: !!row.busy_run_id,
			revision: row.revision,
			label:
				row.title ||
				{
					pipeline: "手順の共同編集",
					interact: "ブラウザの共同作業",
					schedule: "実行予約",
				}[row.kind],
			current: {
				kind: row.kind,
				revision: row.revision,
				request: source?.request,
				child,
			},
			context: source
				? {
						originalRequest: source.request,
						child,
						available:
							row.kind === "schedule"
								? null
								: host().context(db, row.kind, source),
					}
				: {},
		};
	}
	function record(
		db: Database,
		row: WorkRow,
		requestId: string,
		input: unknown,
		result: ChildView,
	) {
		db.query("INSERT INTO collaboration_receipts VALUES(?,?,?,?)").run(
			requestId,
			row.id,
			hash(input),
			JSON.stringify(result),
		);
		return result;
	}
	function prior(
		db: Database,
		row: WorkRow,
		requestId: string,
		input: unknown,
	) {
		const found = db
			.query<
				{ work_id: string; input_digest: string; result_json: string },
				[string]
			>("SELECT * FROM collaboration_receipts WHERE request_id=?")
			.get(requestId);
		if (!found) return null;
		if (found.work_id !== row.id || found.input_digest !== hash(input))
			fail("request_conflict");
		return JSON.parse(found.result_json) as ChildView;
	}
	function authority(db: Database, row: WorkRow): Authority {
		const owner = host().authority(db, row.session_id);
		if (
			!owner?.active ||
			owner.conversationId !== current(db, row).conversationId
		)
			fail("specialist_session_changed");
		return owner;
	}
	function response(db: Database, row: WorkRow, runId: string) {
		const answer = host().source(db, runId),
			original = current(db, row);
		if (
			!answer ||
			answer.conversationId !== original.conversationId ||
			answer.specialistSessionId !== row.session_id
		)
			fail("collaboration_answer_invalid");
		return answer;
	}
	function purge(db: Database, row: WorkRow, erase = false) {
		const ref = sourceRef(row),
			source = ref && host().source(db, ref.runId);
		if (ref && row.child_id && row.kind !== "schedule")
			host().cancel(
				db,
				row.kind,
				source ?? { ...ref, request: "" },
				row.child_id,
			);
		if (erase && ref)
			host().forget(db, row.kind, source ?? { ...ref, request: "" }, row.id);
		db.query("DELETE FROM collaboration_works WHERE id=?").run(row.id);
	}
	return {
		host,
		now,
		current,
		live,
		held,
		state,
		record,
		prior,
		authority,
		response,
		purge,
	};
}
export type WorkContext = ReturnType<typeof createWorkContext>;
