import type { Database } from "bun:sqlite";
import {
	listMemoryChanges,
	latestMemoryChangeSeq,
} from "eumenes-memory/sqlite";
import type { AccessContext } from "eumenes-memory";
import { sha256Hex } from "../../../infrastructure/digest";
import type { ExecutionReference } from "../../tool-runtime";
import { PROFILE_SCOPE } from "../contracts";
import type { WindowSnapshot } from "./context-window";

/** Issued from the already built window; validation follows only changes to that item. */
export function executionReferences(deps: {
	access: (db: Database, purpose: string) => AccessContext;
	ready: (db: Database) => boolean;
	now: () => number;
}) {
	const now = deps.now;
	const input = (db: Database) => ({
		contractVersion: 1 as const,
		access: deps.access(db, "dialogue.delegate"),
		scopeKeys: [PROFILE_SCOPE],
	});
	function issueInTransaction(
		db: Database,
		window: WindowSnapshot,
	): ExecutionReference[] {
		if (!deps.ready(db)) return [];
		const sequence = latestMemoryChangeSeq(db, input(db));
		if (sequence.status !== "ok") return [];
		db.query("DELETE FROM memory_execution_refs WHERE expires_at<=?").run(
			now(),
		);
		return (window.referenceItems ?? []).slice(0, 8).map((item) => {
			const body = JSON.stringify({
				kind: item.kind,
				text: item.text,
				negated: item.negated,
				period: item.period,
			});
			const digest = sha256Hex(body);
			const ref = `memory:${item.itemId}:${item.revision}:${digest.slice(0, 12)}:${sha256Hex(input(db).access.policyRevision).slice(0, 8)}`;
			db.query(
				"INSERT OR IGNORE INTO memory_execution_refs(ref,item_id,revision,body,digest,change_seq,policy_revision,expires_at) VALUES(?,?,?,?,?,?,?,?)",
			).run(
				ref,
				item.itemId,
				String(item.revision),
				body,
				digest,
				sequence.seq,
				input(db).access.policyRevision,
				Math.min(now() + 14 * 86_400_000, item.validUntilMs ?? Infinity),
			);
			return {
				ref,
				owner: "memory",
				id: item.itemId,
				revision: String(item.revision),
				digest,
				label: `${item.kind}: ${item.text.slice(0, 80)}`,
				kind: "memory" as const,
				preview: "",
			};
		});
	}
	function readInTransaction(
		db: Database,
		ref: ExecutionReference,
	): string | null {
		if (!deps.ready(db)) return null;
		const row = db
			.query("SELECT * FROM memory_execution_refs WHERE ref=?")
			.get(ref.ref) as {
			item_id: string;
			revision: string;
			body: string;
			digest: string;
			change_seq: number;
			policy_revision: string;
			expires_at: number;
		} | null;
		if (
			!row ||
			row.expires_at <= now() ||
			row.item_id !== ref.id ||
			row.revision !== ref.revision ||
			row.digest !== ref.digest ||
			row.policy_revision !== input(db).access.policyRevision
		)
			return null;
		let afterSeq = row.change_seq;
		for (;;) {
			const changes = listMemoryChanges(db, {
				...input(db),
				afterSeq,
				limit: 200,
			});
			if (
				changes.status !== "ok" ||
				changes.changes.some((c) => c.targetId === row.item_id)
			)
				return null;
			if (!changes.hasMore) break;
			afterSeq = changes.nextAfterSeq;
		}
		return row.body;
	}
	return {
		issueInTransaction,
		readInTransaction,
		purgeInTransaction(db: Database, ids: readonly string[]) {
			if (
				!db
					.query(
						"SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_execution_refs'",
					)
					.get()
			)
				return;
			for (const id of ids)
				db.query("DELETE FROM memory_execution_refs WHERE item_id=?").run(id);
		},
	};
}
