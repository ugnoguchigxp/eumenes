import type { Database } from "bun:sqlite";
import { confirmationByRef } from "./work";

export type MessageVersion = { id: string; revision: string };

/** Closing the executable confirmation and keeping the sources for its revision are one write. */
export function beginConfirmationRevision(
	db: Database,
	conversationId: string,
	ref: number,
	at: string,
	expiresAt: string,
	versions: MessageVersion[],
	corrections: string[],
	continuing: boolean,
) {
	const row = confirmationByRef(db, conversationId, ref);
	if (!row || !versions.length) return false;
	return (
		db
			.query(
				`UPDATE dialogue_confirmations SET superseded_at=COALESCE(superseded_at,?), expires_at=?, revision_sources_json=?, message_ids_json=?
		WHERE id=? AND (superseded_at IS NULL OR (? AND revision_sources_json IS NOT NULL)) AND used_at IS NULL AND expires_at>?`,
			)
			.run(
				at,
				expiresAt,
				JSON.stringify({ versions, corrections }),
				JSON.stringify(versions.map((s) => s.id)),
				row.id,
				Number(continuing),
				at,
			).changes === 1
	);
}

export function confirmationRevisions(
	db: Database,
	conversationId: string,
	at: string,
) {
	const rows = db
		.query<
			{ ref: number; revision_sources_json: string; nextRef: number | null },
			[string, string]
		>(
			`SELECT ref,revision_sources_json,(SELECT MAX(n.ref) FROM dialogue_confirmations n WHERE n.revises_id=c.id) AS nextRef
		FROM dialogue_confirmations c WHERE conversation_id=? AND revision_sources_json IS NOT NULL AND expires_at>? ORDER BY ref DESC`,
		)
		.all(conversationId, at);
	return rows.map((row) => ({
		row: confirmationByRef(db, conversationId, row.ref)!,
		next: row.nextRef
			? confirmationByRef(db, conversationId, row.nextRef)
			: null,
		...(JSON.parse(row.revision_sources_json) as {
			versions: MessageVersion[];
			corrections: string[];
		}),
	}));
}

/** The corrected statement may be interrupted before delivery. Its predecessor remains a draft until adoption. */
export function linkConfirmationRevision(
	db: Database,
	oldId: string,
	nextId: string,
	at: string,
) {
	db.query(
		"UPDATE dialogue_confirmations SET superseded_at=? WHERE revises_id=? AND used_at IS NULL AND superseded_at IS NULL",
	).run(at, oldId);
	db.query("UPDATE dialogue_confirmations SET revises_id=? WHERE id=?").run(
		oldId,
		nextId,
	);
}

export function cancelConfirmationRevision(
	db: Database,
	conversationId: string,
	ref: number,
	at: string,
) {
	const row = confirmationByRef(db, conversationId, ref);
	if (!row) return false;
	const cleared = db
		.query(
			"UPDATE dialogue_confirmations SET revision_sources_json=NULL WHERE id=? AND revision_sources_json IS NOT NULL",
		)
		.run(row.id).changes;
	if (cleared)
		db.query(
			"UPDATE dialogue_confirmations SET superseded_at=? WHERE revises_id=? AND used_at IS NULL AND superseded_at IS NULL",
		).run(at, row.id);
	return cleared === 1;
}
