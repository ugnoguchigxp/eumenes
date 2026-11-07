import type { Database } from "bun:sqlite";
import type { LiveOutputOrigin } from "../contracts";
import { active, session } from "../repository";
import { sessionInput } from "../repository/inputs";

export function createProposals(
	validateOrigin?: (
		db: Database,
		conversationId: string,
		origin: LiveOutputOrigin,
	) => boolean,
) {
	return {
		proposeInTransaction(
			db: Database,
			conversationId: string,
			text: string,
			origin?: LiveOutputOrigin,
		) {
			const row = active(db, conversationId);
			if (!row || row.test) return false;
			if (origin) {
				const existing = db
					.query(
						"SELECT text,origin_input FROM live_voice_outputs WHERE origin_key=?",
					)
					.get(origin.id) as { text: string; origin_input: string } | null;
				if (existing) {
					if (
						existing.text !== text ||
						existing.origin_input !== JSON.stringify(origin)
					)
						throw new Error("live_proposal_conflict");
					return true;
				}
				if (validateOrigin && !validateOrigin(db, conversationId, origin))
					throw new Error("live_proposal_stale");
			}
			db.query(
				"INSERT INTO live_voice_outputs(session_id,text,kind,origin_key,origin_input,origin_version) VALUES(?,?,'commentary',?,?,?)",
			).run(
				row.id,
				text,
				origin?.id ?? null,
				origin ? JSON.stringify(origin) : null,
				row.input_version,
			);
			return true;
		},
		validInTransaction(db: Database, outputId: number, text: string) {
			const row = db
				.query(
					"SELECT session_id,text,origin_input,origin_version FROM live_voice_outputs WHERE id=?",
				)
				.get(outputId) as {
				session_id: string;
				text: string;
				origin_input: string | null;
				origin_version: number | null;
			} | null;
			if (!row || row.text !== text) return false;
			if (row.origin_input === null) return true;
			const current = session(db, row.session_id);
			if (!current || current.input_version !== row.origin_version)
				return false;
			const origin = JSON.parse(row.origin_input) as LiveOutputOrigin;
			return (
				!validateOrigin || validateOrigin(db, current.conversation_id, origin)
			);
		},
		purgeSourcesInTransaction(db: Database, refs: readonly string[]) {
			if (!refs.length) return;
			const forgotten = new Set(refs);
			for (const row of db
				.query("SELECT id FROM live_voice_sessions")
				.all() as { id: string }[]) {
				const input = sessionInput(db, row.id);
				if (input.complete && !input.sources.some((ref) => forgotten.has(ref)))
					continue;
				db.query(
					"UPDATE live_voice_sessions SET status='interrupted',error='live_history_changed',input_version=input_version+1 WHERE id=? AND status IN ('connecting','active','closing')",
				).run(row.id);
				db.query(
					"UPDATE live_voice_fragments SET delta='' WHERE session_id=? AND segment_id IN (SELECT id FROM live_voice_segments WHERE session_id=? AND speaker='assistant')",
				).run(row.id, row.id);
				db.query(
					"UPDATE live_voice_segments SET text='' WHERE session_id=? AND speaker='assistant'",
				).run(row.id);
				db.query(
					"UPDATE live_voice_outputs SET text='',sent=1 WHERE session_id=?",
				).run(row.id);
				db.query(
					"UPDATE live_voice_notices SET text='' WHERE session_id=?",
				).run(row.id);
			}
			const rows = db
				.query(
					"SELECT id,session_id,origin_input FROM live_voice_outputs WHERE kind='commentary' AND run_id IS NULL AND text<>''",
				)
				.all() as {
				id: number;
				session_id: string;
				origin_input: string | null;
			}[];
			for (const row of rows) {
				const input = row.origin_input
					? (JSON.parse(row.origin_input) as LiveOutputOrigin).input
					: null;
				if (input?.complete && !input.sources.some((ref) => forgotten.has(ref)))
					continue;
				db.query("UPDATE live_voice_outputs SET text='',sent=1 WHERE id=?").run(
					row.id,
				);
				// Already offered text cannot be unsent; interrupt the session before it can keep using it.
				db.query(
					"UPDATE live_voice_sessions SET status='interrupted',error='live_history_changed',input_version=input_version+1 WHERE id=? AND status IN ('connecting','active','closing')",
				).run(row.session_id);
			}
		},
	};
}
