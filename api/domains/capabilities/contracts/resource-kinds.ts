import { z } from "zod";

/**
 * The resource kinds a capabilities item registers (spec/resource-uri-implementation-plan-2026-10-25.md §2.2).
 * Capabilities is tier 0 and cannot import the resources domain, so the action names and the resolved shape
 * are declared here; the resolved `ResourceKindData` is plain data shaped like the resources domain's `ResourceKind`.
 */
export const resourceActionNames = ["open", "play", "read"] as const;
export type ResourceActionName = (typeof resourceActionNames)[number];

/** The same grammar as the kind part of an `eumenes://` URI, bounded like a resource reference's kind. */
export const resourceKindPattern = /^[a-z0-9]+(?:\.[a-z0-9-]+)*$/;
export const resourceKindMax = 80;

const action = z.enum(resourceActionNames);
const word = z.string().trim().min(1).max(20);

/** A `resource-kind` item's data. The kind itself is the item id; the item title equals `label`. */
export const resourceKindRegistration = z
	.strictObject({
		version: z.literal(1),
		/** Display name, e.g. 「画像」. */
		label: z.string().trim().min(1).max(40),
		/** The domain that owns the kind and implements its resource adapter. */
		owner: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
		actions: z.array(action).min(1).max(resourceActionNames.length),
		defaultAction: action,
		/** Per-kind override of the global action words; only for the kind's own actions. */
		actionLabels: z.partialRecord(action, word).optional(),
		/** Toolchain ids whose results create resources of this kind (empty: only the host creates it). */
		producedBy: z.array(z.string().regex(/^[a-z][a-z0-9._-]{0,100}$/)).max(16),
	})
	.refine((v) => new Set(v.actions).size === v.actions.length)
	.refine((v) => v.actions.includes(v.defaultAction))
	.refine((v) =>
		Object.keys(v.actionLabels ?? {}).every((key) =>
			v.actions.includes(key as ResourceActionName),
		),
	)
	.refine((v) => new Set(v.producedBy).size === v.producedBy.length);
export type ResourceKindRegistration = z.infer<typeof resourceKindRegistration>;

/** The `resource-actions` item's data: the one word of each action, for the agency's `nextActions`. */
export const resourceActionWords = z.strictObject({
	version: z.literal(1),
	words: z.strictObject({ open: word, play: word, read: word }),
});
export type ResourceActionWords = z.infer<typeof resourceActionWords>;

/** What a definition's `resourceKindData` holds, by the definition's kind. */
export type ResourceDefinitionData =
	| ResourceKindRegistration
	| ResourceActionWords;

/** The id of the one `resource-actions` item. */
export const resourceActionsItemId = "resource.actions";
/**
 * Capability item ids are unique across every kind, so a resource kind's item is named `resource.<kind>`
 * (a bare `image` or `report` would take the id from a toolchain or requirement profile of that name).
 */
export const RESOURCE_KIND_ITEM_PREFIX = "resource.";
export const resourceKindItemId = (kind: string) =>
	`${RESOURCE_KIND_ITEM_PREFIX}${kind}`;

/** A registered resource kind, resolved: the action words are already merged. */
export type ResourceKindData = {
	kind: string;
	label: string;
	owner: string;
	actions: ResourceActionName[];
	defaultAction: ResourceActionName;
	/** The word of each of the kind's actions: the kind's own override, else the global action word. */
	actionLabels: Partial<Record<ResourceActionName, string>>;
};
