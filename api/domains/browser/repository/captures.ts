import type { Database } from "bun:sqlite";
import {
	activeCaptureStates,
	errorLabel,
	type CaptureState,
	type CaptureView,
} from "../contracts";
import type { CaptureRange } from "../contracts/ports";
import { patchRow } from "./sql";

export type CaptureRow = {
	id: string;
	owner: string;
	conversation_id: string;
	origin: "conversation" | "screen";
	request_id: string;
	task_id: string | null;
	tab_ref: string;
	range: CaptureRange;
	element_ref: string | null;
	observation_ref: string | null;
	state: CaptureState;
	epoch: number;
	step: number;
	deadline: number;
	planned_width: number | null;
	planned_height: number | null;
	png_width: number | null;
	png_height: number | null;
	png_bytes: number | null;
	temp_ref: string | null;
	webp_ref: string | null;
	webp_sha256: string | null;
	webp_bytes: number | null;
	reduction_percent: number | null;
	error_code: string | null;
	announced: number;
	captured_at: number | null;
	revision: number;
	created_at: number;
	updated_at: number;
};

export const captureRow = (db: Database, id: string) =>
	db
		.query("SELECT * FROM browser_captures WHERE id=?")
		.get(id) as CaptureRow | null;
export const captureByRequest = (db: Database, requestId: string) =>
	db
		.query("SELECT * FROM browser_captures WHERE request_id=?")
		.get(requestId) as CaptureRow | null;
export function ownedCapture(db: Database, id: string, owner: string) {
	const r = captureRow(db, id);
	if (!r || r.owner !== owner) throw new Error("browser_capture_not_found");
	return r;
}

export function captureView(r: CaptureRow): CaptureView {
	return {
		captureId: r.id,
		range: r.range,
		capturedAt: new Date(r.captured_at ?? r.created_at).toISOString(),
		width: r.png_width ?? 0,
		height: r.png_height ?? 0,
		bytes: r.webp_bytes ?? 0,
		reductionPercent: r.reduction_percent ?? 0,
		state: r.state,
		taskId: r.task_id,
		errorCode: r.error_code,
		errorLabel: errorLabel(r.error_code),
		revision: r.revision,
	};
}

export function insertCapture(
	db: Database,
	c: {
		id: string;
		owner: string;
		conversationId: string;
		origin: "conversation" | "screen";
		requestId: string;
		taskId: string | null;
		tabRef: string;
		range: CaptureRange;
		elementRef: string | null;
		observationRef: string | null;
		deadline: number;
	},
	now: number,
) {
	db.query(
		`INSERT INTO browser_captures(id,owner,conversation_id,origin,request_id,task_id,tab_ref,range,element_ref,
		 observation_ref,state,deadline,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	).run(
		c.id,
		c.owner,
		c.conversationId,
		c.origin,
		c.requestId,
		c.taskId,
		c.tabRef,
		c.range,
		c.elementRef,
		c.observationRef,
		"queued",
		c.deadline,
		now,
		now,
	);
}

type CaptureChange = Partial<
	Pick<
		CaptureRow,
		| "state"
		| "epoch"
		| "step"
		| "planned_width"
		| "planned_height"
		| "png_width"
		| "png_height"
		| "png_bytes"
		| "temp_ref"
		| "webp_ref"
		| "webp_sha256"
		| "webp_bytes"
		| "reduction_percent"
		| "error_code"
		| "announced"
		| "captured_at"
	>
>;
export function patchCapture(
	db: Database,
	id: string,
	change: CaptureChange,
	now: number,
) {
	patchRow(db, "browser_captures", "id", id, change, now);
	return captureRow(db, id)!;
}

export const listCaptures = (db: Database, owner: string, limit = 50) =>
	(
		db
			.query(
				"SELECT * FROM browser_captures WHERE owner=? ORDER BY created_at DESC, rowid DESC LIMIT ?",
			)
			.all(owner, limit) as CaptureRow[]
	).map(captureView);

export const activeCaptureCount = (db: Database, owner: string) =>
	(
		db
			.query(
				`SELECT COUNT(*) AS n FROM browser_captures WHERE owner=? AND state IN (${activeCaptureStates.map(() => "?").join(",")})`,
			)
			.get(owner, ...activeCaptureStates) as { n: number }
	).n;

export const activeCaptures = (db: Database) =>
	db
		.query(
			`SELECT * FROM browser_captures WHERE state IN (${activeCaptureStates.map(() => "?").join(",")})`,
		)
		.all(...activeCaptureStates) as CaptureRow[];

export const dueCaptures = (db: Database, now: number) =>
	activeCaptures(db).filter((c) => c.deadline <= now);

/** Temp and adopted refs the database knows about; any other file in the capture directory is an orphan. */
export const knownCaptureRefs = (db: Database) =>
	new Set(
		(
			db
				.query(
					"SELECT temp_ref AS ref FROM browser_captures WHERE temp_ref IS NOT NULL UNION SELECT webp_ref FROM browser_captures WHERE webp_ref IS NOT NULL",
				)
				.all() as { ref: string }[]
		).map((r) => r.ref),
	);

export const capturesRevision = (db: Database) =>
	(
		db
			.query("SELECT COALESCE(SUM(revision+1),0) AS n FROM browser_captures")
			.get() as { n: number }
	).n;
