import type { Database } from "bun:sqlite";
import type {
	HostForgetIntent,
	HostSourceState,
	SourceRef,
} from "eumenes-memory";
import type { MemoryDb } from "eumenes-memory/sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { ConversationService } from "../../conversation";
import { bumpForgetSeq } from "../repository";
import { seedEvidence } from "./seed-sources";
import { hostMessageSource } from "./curation-shared";
import { appendJournal, intentOf, readJournal } from "./journal";
import type { createForget } from "./forget";
import type { ContextWindowStore } from "./context-window";

/** The existing application owns all transactions and journal media. No second connection or listener. */
export function createSharedHostPort(deps: {
	store: SqliteStore;
	journalPath: string;
	conversation: ConversationService;
	forgetter: ReturnType<typeof createForget>;
	windows: ContextWindowStore;
	health: { healthy: boolean };
	blocked(db: Database, id: string): boolean;
	isReady(): boolean;
}) {
	return {
		read<T>(fn: (db: MemoryDb) => T): T {
			if (!deps.health.healthy) throw new Error("memory_unavailable");
			return deps.store.readSnapshot((db) => {
				const value = fn(db);
				if (
					value !== null &&
					(typeof value === "object" || typeof value === "function") &&
					typeof (value as { then?: unknown }).then === "function"
				)
					throw new Error("async_snapshot_callback");
				return { value };
			}).value;
		},
		write<T>(fn: (db: MemoryDb) => T): Promise<T> {
			// Startup recovery also uses this port while health is closed.
			return deps.store.write((db) => fn(db));
		},
		journal: {
			read: () => readJournal(deps.journalPath),
			append: (entry: unknown) => appendJournal(deps.journalPath, entry),
		},
		isReady: deps.isReady,
		failClosed: () => {
			deps.health.healthy = false;
		},
		applyHostIntent(
			db: MemoryDb,
			hostIntent: HostForgetIntent,
			forgetId?: string,
		): void {
			if (!forgetId) return;
			// This database came from the application's port; the cast exposes its concrete driver to existing purges.
			const writer = db as Database;
			const intent = intentOf(hostIntent);
			const itemIds = [
				...new Set([...intent.itemIds, ...(hostIntent["host.states"] ?? [])]),
			];
			if (!itemIds.length && !intent.messageIds.length) return;
			deps.forgetter.purgeDerivedInTransaction(writer, {
				forgetId,
				conversationId: intent.conversationId,
				itemIds,
				messageIds: intent.messageIds,
				derived: intent.derived,
			});
			bumpForgetSeq(writer);
			deps.windows.recordImmediateInTransaction(writer, "state_forget", null);
			deps.windows.purgeInTransaction(writer);
		},
		resolveSource(db: MemoryDb, ref: SourceRef): HostSourceState | undefined {
			const reader = db as Database;
			if (ref.namespace !== "conversation" || ref.kind !== "message")
				return seedEvidence(reader, ref)?.source;
			if (deps.blocked(reader, ref.id)) return undefined;
			const found = deps.conversation.messageInTransaction(reader, ref.id);
			return found ? hostMessageSource(found) : undefined;
		},
	};
}
