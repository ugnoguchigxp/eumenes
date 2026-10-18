import type { Database } from "bun:sqlite";
import {
	canonicalText,
	formFields,
	limits,
	savedRendering,
	type Definition,
} from "../contracts";
import { currentWork, get, list, snapshot } from "../repository";
import {
	editableDefinition,
	parseJson,
	scope,
	stateOf,
	type RejectedDraft,
} from "./shared";

// --- reads for the screens ---
export function studioInTransaction(
	db: Database,
	viewingId: string | undefined,
) {
	const row = currentWork(db, scope);
	const state = row ? stateOf(db, row) : null;
	const viewing = viewingId ? get(db, viewingId) : null;
	const viewingDefinition = viewing
		? parseJson<Definition>(viewing.definition_json)
		: null;
	return {
		kind: "ui-studio" as const,
		work:
			row && state
				? {
						workRef: row.id,
						sessionId: row.session_id,
						title: state.current.title,
						definition: state.current.definition,
						revision: row.draft_revision,
						savedRef: row.composition_id,
						savedRevision: row.base_saved_revision,
						dirty: state.dirty,
						busy: state.busy,
						canUndo: !state.busy && row.cursor > 0,
						canRedo: !state.busy && row.cursor < row.snapshot_count - 1,
						/** The canonical text the specialist edits, and the one before it (the screen shows the change). */
						source: state.current.definition
							? canonicalText(state.current.definition)
							: "",
						previousSource: previousSource(db, row.id, row.cursor),
						rejected: parseJson<RejectedDraft>(row.rejected_json),
					}
				: null,
		viewing:
			viewing && viewingDefinition
				? {
						id: viewing.id,
						title: viewing.title,
						definition: savedRendering(viewingDefinition),
						/** The saved definition with its form inline, as the user saved it. */
						storedDefinition: editableDefinition(viewing),
						savedRevision: viewing.saved_revision,
					}
				: null,
		history: list(db, scope, limits.history).map(
			({ id, title, updated_at }) => ({ id, title, updatedAt: updated_at }),
		),
	};
}
/** The revision before the current one as canonical text (empty for the first). */
function previousSource(db: Database, workId: string, cursor: number) {
	if (cursor === 0) return "";
	const definition = parseJson<Definition>(
		snapshot(db, workId, cursor - 1)?.definition_json ?? null,
	);
	return definition ? canonicalText(definition) : "";
}
export function formInTransaction(db: Database, id: string) {
	const row = get(db, id);
	if (!row || row.scope !== scope || !row.fields_json) return null;
	return {
		revision: row.saved_revision,
		fields: formFields.parse(JSON.parse(row.fields_json)),
	};
}
