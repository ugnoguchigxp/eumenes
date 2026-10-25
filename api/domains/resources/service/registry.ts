import type { Database } from "bun:sqlite";
import {
	parseResourceUri,
	type ParsedResourceUri,
	type ResolvedResource,
	type ResourceAction,
	type ResourceAdapter,
	type ResourceErrorCode,
	type ResourceKind,
	type ResourceRef,
	type ResourceRegistry,
	type ResourceSearch,
	type ResourceView,
} from "../contracts";

export const RESOURCE_SEARCH_LIMIT_MAX = 10;

type Failure = { ok: false; code: ResourceErrorCode };

/** The ids the registry can return for a limit outside 1..10. */
const clampLimit = (limit: number) =>
	Math.min(
		Math.max(Number.isFinite(limit) ? Math.floor(limit) : 1, 1),
		RESOURCE_SEARCH_LIMIT_MAX,
	);

/** Newest first; equal instants fall back to the URI so the order is stable. */
const newestFirst = (a: ResourceRef, b: ResourceRef) =>
	Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
	(a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0);

/**
 * Builds the registry the application wires: the kinds come from capabilities (read on every call, so a
 * changed registration applies at once), the adapters from the domains that own each kind. The registry holds
 * no business rule of a kind; it checks the kind's registration and delegates the rest to the adapter.
 */
export function createResourceRegistry(input: {
	kinds: () => ResourceKind[];
	adapters: ResourceAdapter[];
}): ResourceRegistry {
	const adapters = new Map<string, ResourceAdapter>();
	for (const adapter of input.adapters) {
		if (adapters.has(adapter.kind))
			throw new Error(`resource_adapter_duplicate:${adapter.kind}`);
		adapters.set(adapter.kind, adapter);
	}
	const kindOf = (kind: string) =>
		input.kinds().find((entry) => entry.kind === kind) ?? null;

	/** Parses the URI and finds the registration and the owner; a kind needs both. */
	const locate = (
		uri: string,
	):
		| {
				ok: true;
				parsed: ParsedResourceUri;
				kind: ResourceKind;
				adapter: ResourceAdapter;
		  }
		| Failure => {
		const parsed = parseResourceUri(uri);
		if (!parsed) return { ok: false, code: "resource_uri_invalid" };
		const kind = kindOf(parsed.kind);
		const adapter = adapters.get(parsed.kind);
		if (!kind || !adapter) return { ok: false, code: "resource_kind_unknown" };
		return { ok: true, parsed, kind, adapter };
	};

	/** The actions both the registration allows and the owner lists for this resource, the default first. */
	const actionsOf = (kind: ResourceKind, view: ResourceView) => {
		const allowed = kind.actions.filter((action) =>
			view.actions.includes(action),
		);
		return [
			...allowed.filter((action) => action === kind.defaultAction),
			...allowed.filter((action) => action !== kind.defaultAction),
		];
	};

	const resolve = (
		db: Database,
		uri: string,
		action?: ResourceAction,
	):
		| {
				ok: true;
				resource: ResolvedResource;
				adapter: ResourceAdapter;
				id: string;
		  }
		| Failure => {
		const found = locate(uri);
		if (!found.ok) return found;
		if (action && !found.kind.actions.includes(action))
			return { ok: false, code: "action_not_allowed" };
		const view = found.adapter.getInTransaction(db, found.parsed.id);
		if (!view) return { ok: false, code: "item_not_found" };
		const actions = actionsOf(found.kind, view);
		if (action && !actions.includes(action))
			return { ok: false, code: "action_not_allowed" };
		return {
			ok: true,
			adapter: found.adapter,
			id: found.parsed.id,
			resource: {
				...view,
				uri: found.parsed.uri,
				kind: found.kind.kind,
				actions,
				kindLabel: found.kind.label,
				defaultAction: found.kind.defaultAction,
				actionLabels: found.kind.actionLabels,
			},
		};
	};

	return {
		kinds: () => input.kinds(),
		kind: kindOf,
		adapter: (kind) => adapters.get(kind) ?? null,
		resolveInTransaction(db, uri) {
			const resolved = resolve(db, uri);
			return resolved.ok ? { ok: true, resource: resolved.resource } : resolved;
		},
		async search(query: ResourceSearch & { kinds?: string[] }, signal) {
			const limit = clampLimit(query.limit);
			const named = query.kinds ? new Set(query.kinds) : null;
			const targets = input
				.kinds()
				.filter((kind) => !named || named.has(kind.kind))
				.flatMap((kind) => adapters.get(kind.kind) ?? []);
			const { kinds: _kinds, ...search } = query;
			// One owner that cannot answer (its service down) leaves the others' resources.
			const lists = await Promise.allSettled(
				targets.map((adapter) => adapter.search({ ...search, limit }, signal)),
			);
			signal.throwIfAborted();
			return lists
				.flatMap((list) => (list.status === "fulfilled" ? list.value : []))
				.sort(newestFirst)
				.slice(0, limit);
		},
		async read(db, uri, signal) {
			const resolved = resolve(db, uri, "read");
			if (!resolved.ok) return resolved;
			const { text } = await resolved.adapter.read(resolved.id, signal);
			return { ok: true, text };
		},
	};
}
