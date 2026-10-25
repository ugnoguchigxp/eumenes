import type { Database } from "bun:sqlite";
import type { ResourceReadPort } from "../../domains/agent-runtime";
import type { ConversationResourcePort } from "../../domains/dialogue";
import type { ResourceRegistry } from "../../domains/resources";
import type { ScreenService } from "../../domains/screen";
import type { SqliteStore } from "../../infrastructure/sqlite";

type Attached = {
	registry: ResourceRegistry;
	ledger: ConversationResourcePort;
	screen: ScreenService;
};

/**
 * The toolchain is built before the resource registry, the conversation's ledger and the screen commands exist
 * (they need the dialogue). Its `resources` tool and the sub-agents' `resource.read` get these stand-ins, which
 * reach the real parts once `attach` has run; a call before that fails as `resources_unavailable`.
 */
export function createLateResources(store: SqliteStore) {
	let attached: Attached | undefined;
	const need = () => {
		if (!attached) throw new Error("resources_unavailable");
		return attached;
	};
	const registry: ResourceRegistry = {
		kinds: () => need().registry.kinds(),
		kind: (kind) => need().registry.kind(kind),
		adapter: (kind) => need().registry.adapter(kind),
		resolveInTransaction: (db, uri) =>
			need().registry.resolveInTransaction(db, uri),
		search: (query, signal) => need().registry.search(query, signal),
		read: (db, uri, signal) => need().registry.read(db, uri, signal),
		prepareInTransaction: (db, uri, action, context) =>
			need().registry.prepareInTransaction(db, uri, action, context),
	};
	const ledger: ConversationResourcePort = {
		enterInTransaction: (db, input) =>
			need().ledger.enterInTransaction(db, input),
		byRefInTransaction: (db, conversationId, ref) =>
			need().ledger.byRefInTransaction(db, conversationId, ref),
		touchInTransaction: (db, resourceId) =>
			need().ledger.touchInTransaction(db, resourceId),
		linkMessageInTransaction: (db, messageId, resourceIds) =>
			need().ledger.linkMessageInTransaction(db, messageId, resourceIds),
	};
	const screen = {
		issueInTransaction: (
			db: Database,
			input: Parameters<ScreenService["issueInTransaction"]>[1],
		) => need().screen.issueInTransaction(db, input),
	} as Pick<ScreenService, "issueInTransaction"> as ScreenService;
	const read: ResourceReadPort = {
		read: async (uri, signal) => {
			const result = await store.read((db) =>
				need().registry.read(db, uri, signal),
			);
			return result.ok
				? { ok: true, text: result.text }
				: { ok: false, code: result.code };
		},
	};
	return {
		tool: { registry, ledger, screen, store },
		read,
		attach(parts: Attached) {
			attached = parts;
		},
	};
}
export type LateResources = ReturnType<typeof createLateResources>;
