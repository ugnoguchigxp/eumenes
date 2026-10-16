import type { Database } from "bun:sqlite";
import { deactivateState } from "eumenes-memory/sqlite";
import type { CurationItem, CurationResult } from "../contracts";
import {
	MAX_TEXT_CHARS,
	applied,
	isStateKind,
	rejected,
	type CurationDeps,
} from "./curation-shared";
import { validityBounds, type EvidenceBuilder } from "./curation-evidence";
import type { StateWriter } from "./curation-state";
import { normalizeKey } from "./quote";

/** remember, update and stop: one State item each. */
export function createStateOps(
	deps: CurationDeps,
	evidence: EvidenceBuilder,
	writer: StateWriter,
) {
	const { windows } = deps;
	const { evidenceFrom } = evidence;
	const { writeState, stored, activeAt } = writer;

	function remember(
		db: Database,
		conversationId: string,
		item: Extract<CurationItem, { op: "remember" }>,
	): CurationResult {
		const key = normalizeKey(item.key);
		if (key === null) return rejected("remember", "invalid_key");
		if (!isStateKind(item.kind)) return rejected("remember", "invalid_input");
		const text = item.text.trim();
		if (text === "" || [...text].length > MAX_TEXT_CHARS)
			return rejected("remember", "invalid_input");
		const validity = validityBounds(item);
		if (validity === "invalid") return rejected("remember", "invalid_validity");
		const built = evidenceFrom(
			db,
			conversationId,
			item.messageId,
			item.quote,
			text,
		);
		if (!built.ok) return rejected("remember", built.reason);
		const explicit = item.explicit === true;
		const written = writeState(db, {
			kind: item.kind,
			semanticKey: key,
			text,
			negated: item.negated === true,
			evidence: [built.evidence],
			sources: [built.source],
			origin: explicit ? "user_confirmed" : "agent_inferred",
			validity,
			force: explicit,
		});
		return stored("remember", db, written, built, explicit);
	}

	function update(
		db: Database,
		conversationId: string,
		item: Extract<CurationItem, { op: "update" }>,
	): CurationResult {
		const target = activeAt(db, item.itemId, item.revision);
		if ("reason" in target) return rejected("update", target.reason);
		if (!isStateKind(target.item.kind))
			return rejected("update", "invalid_input");
		const text = item.text.trim();
		if (text === "" || [...text].length > MAX_TEXT_CHARS)
			return rejected("update", "invalid_input");
		const validity = validityBounds(item);
		if (validity === "invalid") return rejected("update", "invalid_validity");
		const built = evidenceFrom(
			db,
			conversationId,
			item.messageId,
			item.quote,
			text,
		);
		if (!built.ok) return rejected("update", built.reason);
		const explicit = item.explicit === true;
		const written = writeState(db, {
			kind: target.item.kind,
			semanticKey: target.item.semanticKey,
			text,
			negated: item.negated ?? target.item.value.polarity === "negated",
			evidence: [built.evidence],
			sources: [built.source],
			origin: explicit ? "user_confirmed" : "agent_inferred",
			validity,
			force: explicit,
		});
		return stored("update", db, written, built, explicit);
	}

	function stop(
		db: Database,
		item: Extract<CurationItem, { op: "stop" }>,
	): CurationResult {
		const target = activeAt(db, item.itemId, item.revision);
		if ("reason" in target) return rejected("stop", target.reason);
		const result = deactivateState(db, {
			...deps.scoped(db, "memory.write"),
			clock: { atMs: deps.atMs() },
			itemId: item.itemId,
			expectedRevision: item.revision,
		});
		if (result.status !== "applied" && result.status !== "unchanged")
			return rejected(
				"stop",
				result.status === "rejected" && result.reasonCode === "STALE_REVISION"
					? "item_changed"
					: "conflict",
			);
		// Stopping removes a value from the published layer at once.
		if (result.status === "applied")
			windows.recordImmediateInTransaction(db, "state_stop", null);
		return applied("stop", {
			id: result.item.itemId,
			revision: result.item.revision,
			changed: result.status === "applied",
		});
	}

	return { remember, update, stop };
}
