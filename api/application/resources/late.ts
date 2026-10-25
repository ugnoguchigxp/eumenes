import type { ResourceReadPort } from "../../domains/agent-runtime";
import type { ResourceRegistry } from "../../domains/resources";
import type { SqliteStore } from "../../infrastructure/sqlite";

/**
 * The toolchain is built before the resource registry exists (it needs the dialogue). The sub-agents'
 * `resource.read` gets this stand-in, which reaches the registry once `attach` has run; a call before that fails
 * as `resources_unavailable`.
 */
export function createLateResources(store: SqliteStore) {
	let registry: ResourceRegistry | undefined;
	const need = () => {
		if (!registry) throw new Error("resources_unavailable");
		return registry;
	};
	const read: ResourceReadPort = {
		read: async (uri, signal) => {
			const result = await store.read((db) => need().read(db, uri, signal));
			return result.ok
				? { ok: true, text: result.text }
				: { ok: false, code: result.code };
		},
	};
	return {
		read,
		attach(attached: ResourceRegistry) {
			registry = attached;
		},
	};
}
export type LateResources = ReturnType<typeof createLateResources>;
