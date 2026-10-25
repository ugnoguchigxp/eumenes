import type { SqliteStore } from "../../infrastructure/sqlite";
import {
	createResourceRegistry,
	type ResolveResourceResponse,
	type ResourceAdapter,
	type ResourceKind,
	type SearchResourcesResponse,
} from "../../domains/resources";

export type ResourceAccessDeps = {
	store: SqliteStore;
	/** The registered kinds (capabilities `resource-kind` items), read on every call. */
	kinds: () => ResourceKind[];
	/** One adapter per kind, from the domain that owns it. */
	adapters: ResourceAdapter[];
};

export type ResourceSearchRequest = {
	text: string;
	/** A kind's display label or its kind id. */
	kind?: string;
	since?: string;
	until?: string;
	limit: number;
};

/** The resource registry wired to the store: resolve, search, read and prepare for the application. */
export function createResourceAccess(deps: ResourceAccessDeps) {
	const registry = createResourceRegistry({
		kinds: deps.kinds,
		adapters: deps.adapters,
	});
	return {
		registry,
		resolve(uri: string): ResolveResourceResponse {
			return deps.store.read((db) => registry.resolveInTransaction(db, uri));
		},
		async search(
			request: ResourceSearchRequest,
			signal: AbortSignal,
		): Promise<SearchResourcesResponse> {
			const { kind: named, ...query } = request;
			let kinds: string[] | undefined;
			if (named !== undefined) {
				const wanted = named.trim();
				kinds = registry
					.kinds()
					.filter((kind) => kind.kind === wanted || kind.label === wanted)
					.map((kind) => kind.kind);
				if (kinds.length === 0) return { resources: [] };
			}
			const found = await registry.search({ ...query, kinds }, signal);
			return {
				resources: found.flatMap((resource) => {
					const kind = registry.kind(resource.kind);
					return kind ? [{ ...resource, kindLabel: kind.label }] : [];
				}),
			};
		},
	};
}

export type ResourceAccess = ReturnType<typeof createResourceAccess>;
