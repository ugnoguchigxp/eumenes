import type { Database } from "bun:sqlite";
import type { LiveReferenceInput } from "../contracts";

export function sessionInput(db: Database, id: string): LiveReferenceInput {
	const row = db
		.query("SELECT input_json FROM live_voice_sessions WHERE id=?")
		.get(id) as { input_json: string | null } | null;
	return row?.input_json
		? (JSON.parse(row.input_json) as LiveReferenceInput)
		: { sources: [], complete: false };
}
export function addSessionInput(
	db: Database,
	id: string,
	input: LiveReferenceInput,
) {
	const previous = sessionInput(db, id);
	const next = {
		sources: [...new Set([...previous.sources, ...input.sources])],
		complete: previous.complete && input.complete,
	};
	db.query("UPDATE live_voice_sessions SET input_json=? WHERE id=?").run(
		JSON.stringify(next),
		id,
	);
}
