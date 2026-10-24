import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { ContinuityItem, ContinuityService } from "../../continuity";
import type { MemoryContextDto, MemoryTendencyDto } from "../contracts";
import { listActiveTendencies, readSettings } from "../repository";
import { referenceJson } from "../../../infrastructure/reference-json";
import type { ContextWindowStore, WindowSnapshot } from "./context-window";
import { profileItemFields } from "./profile";

/**
 * What the settings screen reads besides State: short-term notes, tendencies, and the long-term part of the
 * ContextWindow (the published profile). Every body fails closed while memory is unhealthy (an inconsistent journal may mean a
 * forgotten value is still in this database).
 */
export function createMemoryViews(deps: {
	store: SqliteStore;
	continuity: ContinuityService;
	windows: ContextWindowStore;
	healthy: () => boolean;
}) {
	const { store, continuity, windows, healthy } = deps;
	const contextOf = (window: WindowSnapshot): MemoryContextDto => ({
		version: window.version,
		profile: {
			text: referenceJson(window.profile.items.map(profileItemFields)),
			tokens: window.profile.tokens,
		},
		newMemories: window.newMemories.length,
		notices: window.notices.length,
	});
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
		/** The conversation's ContextWindow as it would be read now (a write transaction: it may rebuild). */
		context(conversationId: string): Promise<MemoryContextDto> {
			return store.write((db): MemoryContextDto => {
				if (!healthy() || !readSettings(db).enabled) return { disabled: true };
				return contextOf(windows.readForRunInTransaction(db, conversationId));
			});
		},
		/**
		 * The ContextWindow last built for the conversation, read without building it (a read
		 * connection cannot): `version` says which build it is. null when none was built yet.
		 */
		storedContext(conversationId: string): MemoryContextDto | null {
			return store.read((db): MemoryContextDto | null => {
				if (!healthy() || !readSettings(db).enabled) return { disabled: true };
				const window = windows.storedInTransaction(db, conversationId);
				return window ? contextOf(window) : null;
			});
		},
	};
}
