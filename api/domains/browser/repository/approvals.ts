import type { Database } from "bun:sqlite";
import type { ApprovalAction, ApprovalKind, ApprovalState } from "../contracts";

export type ApprovalRow = {
	id: string;
	owner: string;
	conversation_id: string;
	task_id: string;
	kind: ApprovalKind;
	tab_ref: string;
	/** Origin and path only. */
	url: string;
	action: string;
	element: string;
	value_digest: string | null;
	/** An `input_value` approval's value until the user answers or it expires; null afterwards. */
	value: string | null;
	summary: string;
	/** The grant an approved `input_value` became. */
	grant_ref: string | null;
	/** The Script variable an `input_value` approval is for. */
	variable: string | null;
	status: ApprovalState;
	expires_at: number;
	created_at: number;
	updated_at: number;
};

export function insertApproval(
	db: Database,
	a: Omit<ApprovalRow, "status" | "grant_ref" | "created_at" | "updated_at">,
	now: number,
) {
	db.query(
		`INSERT INTO browser_approvals(id,owner,conversation_id,task_id,kind,tab_ref,url,action,element,value_digest,value,
		 summary,variable,status,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)`,
	).run(
		a.id,
		a.owner,
		a.conversation_id,
		a.task_id,
		a.kind,
		a.tab_ref,
		a.url,
		a.action,
		a.element,
		a.value_digest,
		a.value,
		a.summary,
		a.variable,
		a.expires_at,
		now,
		now,
	);
}

export const pendingApprovals = (db: Database, taskId: string, now: number) =>
	db
		.query(
			"SELECT * FROM browser_approvals WHERE task_id=? AND status='pending' AND expires_at>? ORDER BY created_at, rowid",
		)
		.all(taskId, now) as ApprovalRow[];

/** Approved and not yet used: what the follow-up task may do now. */
export const approvedApprovals = (db: Database, taskId: string, now: number) =>
	db
		.query(
			"SELECT * FROM browser_approvals WHERE task_id=? AND status='approved' AND expires_at>? ORDER BY created_at, rowid",
		)
		.all(taskId, now) as ApprovalRow[];

/** Hands a pending approval to the follow-up task as approved; an `input_value` keeps no value, its grant has it. */
export function approveInto(
	db: Database,
	id: string,
	taskId: string,
	grantRef: string | null,
	now: number,
) {
	db.query(
		`UPDATE browser_approvals SET task_id=?, status='approved', grant_ref=?, value=NULL, updated_at=?
		 WHERE id=? AND status='pending'`,
	).run(taskId, grantRef, now, id);
}

/**
 * Uses one approved approval: same task, tab, page, action, element and value digest. Returns false when
 * none matches, so a changed operation never rides on another one's approval.
 */
export function consumeApproval(
	db: Database,
	m: {
		taskId: string;
		tabRef: string;
		url: string;
		action: ApprovalAction;
		element: string;
		valueDigest: string | null;
	},
	now: number,
) {
	const r = db
		.query(
			`UPDATE browser_approvals SET status='consumed', value=NULL, updated_at=?
			 WHERE id=(SELECT id FROM browser_approvals WHERE task_id=? AND kind='operation' AND status='approved'
			  AND expires_at>? AND tab_ref=? AND url=? AND action=? AND element=? AND COALESCE(value_digest,'')=?
			  ORDER BY created_at, rowid LIMIT 1)`,
		)
		.run(
			now,
			m.taskId,
			now,
			m.tabRef,
			m.url,
			m.action,
			m.element,
			m.valueDigest ?? "",
		);
	return r.changes > 0;
}

/** A task that ended keeps no open approval and no transient value. */
export const endTaskApprovals = (db: Database, taskId: string, now: number) =>
	db
		.query(
			"UPDATE browser_approvals SET status='expired', value=NULL, updated_at=? WHERE task_id=? AND status IN ('pending','approved')",
		)
		.run(now, taskId);

export const expireApprovals = (db: Database, now: number) =>
	db
		.query(
			"UPDATE browser_approvals SET status='expired', value=NULL, updated_at=? WHERE status IN ('pending','approved') AND expires_at<=?",
		)
		.run(now, now);
