import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { ContinuityItem, ContinuityService } from "../../continuity";
import type { MemoryContextDto, MemoryTendencyDto } from "../contracts";
import {
	deleteTendency,
	listActiveTendencies,
	readSettings,
} from "../repository";
import { LONG_TERM_BYTES, SHORT_TERM_BYTES } from "./context-render";
import type { ContextWindowStore } from "./context-window";

/**
 * What the settings screen reads besides State: short-term notes, tendencies, and the ContextWindow
 * itself. Every body fails closed while memory is unhealthy (an inconsistent journal may mean a
 * forgotten value is still in this database).
 */
export function createMemoryViews(deps: {
	store: SqliteStore;
	continuity: ContinuityService;
	windows: ContextWindowStore;
	healthy: () => boolean;
}) {
	const { store, continuity, windows, healthy } = deps;
	return {
		/** Active, unexpired short-term notes of a conversation. Empty while memory is unhealthy. */
		shortTerm(conversationId: string): ContinuityItem[] {
			if (!healthy()) return [];
			return store.read(
				(db) => continuity.snapshotInTransaction(db, conversationId).items,
			);
		},
		tendencies(): MemoryTendencyDto[] {
			if (!healthy()) return [];
			return store.read((db) =>
				listActiveTendencies(db).map(({ id, text, revision, updatedAt }) => ({
					id,
					text,
					revision,
					updatedAt,
				})),
			);
		},
		/** Removes a tendency for good (the user's call); runs in flight are expired, as for any removal. */
		deleteTendency(id: string): Promise<{ ok: true }> {
			return store.write((db) => {
				if (!healthy()) throw new Error("memory_unavailable");
				if (!deleteTendency(db, id)) throw new Error("invalid_memory_item");
				windows.recordImmediateInTransaction(db, "tendency_delete", null);
				// The rendered windows still carry the deleted text.
				windows.purgeInTransaction(db);
				return { ok: true as const };
			});
		},
		/** The conversation's ContextWindow as it would be read now (a write transaction: it may rebuild). */
		context(conversationId: string): Promise<MemoryContextDto> {
			return store.write((db): MemoryContextDto => {
				if (!healthy() || !readSettings(db).enabled) return { disabled: true };
				const window = windows.readForRunInTransaction(db, conversationId);
				return {
					version: window.version,
					longTerm: {
						text: window.longTerm.text,
						bytes: window.longTerm.bytes,
						limit: LONG_TERM_BYTES,
					},
					shortTerm: {
						text: window.shortTerm.text,
						bytes: window.shortTerm.bytes,
						limit: SHORT_TERM_BYTES,
						pendingAdditions: window.shortTerm.pendingAdditions,
					},
					notices: window.notices.length,
				};
			});
		},
	};
}
