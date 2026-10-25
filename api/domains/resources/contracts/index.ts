import type { Database } from "bun:sqlite";
import { z } from "zod";

/**
 * Eumenes resource URIs (spec/resource-uri-implementation-plan-2026-10-25.md §2):
 * `eumenes://<kind>/<id>[?action=<action>]`. The stored form never carries `action`.
 */
export const RESOURCE_SCHEME = "eumenes:";

export const resourceActions = ["open", "play", "read"] as const;
export type ResourceAction = (typeof resourceActions)[number];

const KIND = /^[a-z0-9]+(?:\.[a-z0-9-]+)*$/;
export const RESOURCE_ID_MAX = 160;
export const RESOURCE_LABEL_MAX = 120;

export type ParsedResourceUri = {
	/** The stored form: `eumenes://<kind>/<encoded id>`. */
	uri: string;
	kind: string;
	id: string;
	action?: ResourceAction;
};

/** The canonical URI of a resource; throws on a kind or id outside the grammar. */
export function formatResourceUri(kind: string, id: string): string {
	if (!KIND.test(kind)) throw new Error("resource_kind_invalid");
	if (id.length < 1 || id.length > RESOURCE_ID_MAX)
		throw new Error("resource_id_invalid");
	return `eumenes://${kind}/${encodeURIComponent(id)}`;
}

/** Parses a resource URI; null when it is not one (any other scheme, a bad kind, id or action). */
export function parseResourceUri(text: string): ParsedResourceUri | null {
	const match = /^eumenes:\/\/([^/?#]+)\/([^/?#]+)(?:\?([^#]*))?$/i.exec(
		text.trim(),
	);
	if (!match) return null;
	const kind = match[1]!.toLowerCase();
	if (!KIND.test(kind)) return null;
	let id: string;
	try {
		id = decodeURIComponent(match[2]!);
	} catch {
		return null;
	}
	if (id.length < 1 || id.length > RESOURCE_ID_MAX) return null;
	let action: ResourceAction | undefined;
	if (match[3] !== undefined) {
		const params = new URLSearchParams(match[3]);
		const keys = [...params.keys()];
		if (keys.some((key) => key !== "action") || keys.length > 1) return null;
		const value = params.get("action");
		if (value !== null) {
			if (!(resourceActions as readonly string[]).includes(value)) return null;
			action = value as ResourceAction;
		}
	}
	return {
		uri: formatResourceUri(kind, id),
		kind,
		id,
		...(action ? { action } : {}),
	};
}

export const resourceUriSchema = z
	.string()
	.max(512)
	.refine((text) => parseResourceUri(text) !== null, "resource_uri_invalid");

/** A resource as stored and passed around: the URI is the identity, the rest is for display. */
export const resourceRefSchema = z.strictObject({
	uri: resourceUriSchema,
	kind: z.string().min(1).max(80),
	label: z.string().trim().min(1).max(RESOURCE_LABEL_MAX),
	createdAt: z.iso.datetime({ offset: true }),
});
export type ResourceRef = z.infer<typeof resourceRefSchema>;

/** What a resource opens as on the Web: the screen adapter and the target inside it. */
export type ResourceView = ResourceRef & {
	adapterRef: string;
	targetRef: string;
	/** Allowed actions, the kind's default first. */
	actions: ResourceAction[];
	/** A short preview (thumbnail URL for images, one line otherwise). */
	preview?: string;
};

export type ResourceSearch = {
	text: string;
	since?: string;
	until?: string;
	limit: number;
};

/**
 * One resource kind's access, implemented by the domain that owns the kind
 * (§5 of the plan). Ids are the owner's own ids, never URIs.
 */
/** Where an adapter call comes from: the conversation, and for a finished TODO its run and TODO. */
export type ResourceContext = {
	conversationId: string;
	runId?: string;
	workId?: string;
};

export interface ResourceAdapter {
	kind: string;
	/** The resources a finished TODO's result produced; called in the completion transaction. */
	fromResultInTransaction(
		db: Database,
		result: unknown,
		context: ResourceContext,
	): ResourceRef[];
	/** null when deleted or not visible. */
	getInTransaction(db: Database, id: string): ResourceView | null;
	/** The owner's own list, newest first; never copied elsewhere. */
	search(query: ResourceSearch, signal: AbortSignal): Promise<ResourceRef[]>;
	/** At most 600 estimated tokens, shortened by the owner (the host never truncates). */
	read(id: string, signal: AbortSignal): Promise<{ text: string }>;
	/** Preparation before an action, e.g. a one-track playlist before `play`. */
	prepareInTransaction?(
		db: Database,
		id: string,
		action: ResourceAction,
		context: ResourceContext,
	): { adapterRef: string; targetRef: string };
}

/** A registered resource kind (capabilities `resource-kind` item, resolved to plain data). */
export type ResourceKind = {
	kind: string;
	/** Display name, e.g. 「画像」. */
	label: string;
	owner: string;
	actions: ResourceAction[];
	defaultAction: ResourceAction;
	/** The words of each action for the agency's `nextActions`, e.g. { play: "再生する" }. */
	actionLabels: Partial<Record<ResourceAction, string>>;
};

export type ResolvedResource = ResourceView & {
	kindLabel: string;
	defaultAction: ResourceAction;
	actionLabels: Partial<Record<ResourceAction, string>>;
};

export type ResourceErrorCode =
	| "resource_uri_invalid"
	| "resource_kind_unknown"
	| "item_not_found"
	| "action_not_allowed";

/** The registry the application wires: kinds from capabilities, adapters from their owners. */
export interface ResourceRegistry {
	kinds(): ResourceKind[];
	kind(kind: string): ResourceKind | null;
	adapter(kind: string): ResourceAdapter | null;
	resolveInTransaction(
		db: Database,
		uri: string,
	):
		| { ok: true; resource: ResolvedResource }
		| { ok: false; code: ResourceErrorCode };
	/** Across kinds (or the named ones), newest first, at most `limit`. */
	search(
		query: ResourceSearch & { kinds?: string[] },
		signal: AbortSignal,
	): Promise<ResourceRef[]>;
	read(
		db: Database,
		uri: string,
		signal: AbortSignal,
	): Promise<
		{ ok: true; text: string } | { ok: false; code: ResourceErrorCode }
	>;
	/** Checks the action against the kind and runs the owner's preparation. */
	prepareInTransaction(
		db: Database,
		uri: string,
		action: ResourceAction,
		context: ResourceContext,
	):
		| { ok: true; adapterRef: string; targetRef: string }
		| { ok: false; code: ResourceErrorCode };
}

/* HTTP shapes (§9). */

export type ResolveResourceResponse =
	| { ok: true; resource: ResolvedResource }
	| { ok: false; code: ResourceErrorCode };

export type SearchResourcesResponse = {
	resources: Array<ResourceRef & { kindLabel: string }>;
};

/** `GET /api/conversations/:id/resources`: the conversation's ledger and the messages each resource is linked to. */
export type ConversationResourcesResponse = {
	resources: Array<{
		ref: string; // `a<n>`
		uri: string;
		kind: string;
		kindLabel: string;
		label: string;
		actions: ResourceAction[];
		preview?: string;
		forgotten: boolean;
	}>;
	messages: Array<{ messageId: string; uris: string[] }>;
};

export * from "./screen";
