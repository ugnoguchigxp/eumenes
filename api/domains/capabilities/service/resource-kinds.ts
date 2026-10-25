import type { Database } from "bun:sqlite";
import type { Definition } from "../contracts";
import {
	RESOURCE_KIND_ITEM_PREFIX,
	resourceActionNames,
	resourceActionsItemId,
	resourceActionWords,
	resourceKindMax,
	resourceKindPattern,
	resourceKindRegistration,
	type ResourceActionName,
	type ResourceKindData,
	type ResourceKindRegistration,
} from "../contracts/resource-kinds";

/** The definition kinds that hold registrations instead of agent material: never indexed for search. */
export const resourceDefinitionKinds: readonly Definition["kind"][] = [
	"resource-kind",
	"resource-actions",
];

/** Checks a `resource-kind` / `resource-actions` definition; throws the code the bundle reports. */
export function validateResourceDefinition(d: Definition) {
	if (
		d.dependencies.length ||
		d.discoveryMode !== undefined ||
		d.backend !== undefined ||
		d.schemaKey !== undefined ||
		d.body !== undefined
	)
		throw new Error("invalid_resource_kind");
	if (d.kind === "resource-actions") {
		if (
			d.id !== resourceActionsItemId ||
			!resourceActionWords.safeParse(d.resourceKindData).success
		)
			throw new Error("invalid_resource_kind");
		return;
	}
	const parsed = resourceKindRegistration.safeParse(d.resourceKindData);
	const kind = d.id.slice(RESOURCE_KIND_ITEM_PREFIX.length);
	if (
		!parsed.success ||
		!d.id.startsWith(RESOURCE_KIND_ITEM_PREFIX) ||
		kind.length > resourceKindMax ||
		!resourceKindPattern.test(kind) ||
		d.title !== parsed.data.label
	)
		throw new Error("invalid_resource_kind");
}

type Active = { kind: string; data: ResourceKindRegistration };

function activeData(db: Database, kind: Definition["kind"]) {
	return (
		db
			.query(
				"SELECT i.id,r.definition_json FROM capability_items i JOIN capability_revisions r ON r.id=i.active_revision_id WHERE i.kind=? AND i.enabled=1 ORDER BY i.id",
			)
			.all(kind) as { id: string; definition_json: string }[]
	).map((row) => ({
		id: row.id,
		data: (JSON.parse(row.definition_json) as Definition).resourceKindData,
	}));
}

function activeKinds(db: Database): Active[] {
	return activeData(db, "resource-kind").map((row) => ({
		kind: row.id.slice(RESOURCE_KIND_ITEM_PREFIX.length),
		data: resourceKindRegistration.parse(row.data),
	}));
}

/** The global action words, absent where none is registered. */
function actionWords(db: Database) {
	const row = activeData(db, "resource-actions").find(
		(item) => item.id === resourceActionsItemId,
	);
	return row ? resourceActionWords.parse(row.data).words : undefined;
}

/**
 * Every enabled resource kind with its action words resolved: for each of the kind's actions, the
 * kind's own `actionLabels` entry, else the global word of that action.
 */
export function resourceKindsInTransaction(db: Database): ResourceKindData[] {
	const words = actionWords(db);
	return activeKinds(db).map(({ kind, data }) => {
		const actionLabels: Partial<Record<ResourceActionName, string>> = {};
		for (const name of resourceActionNames) {
			if (!data.actions.includes(name)) continue;
			const word = data.actionLabels?.[name] ?? words?.[name];
			if (word !== undefined) actionLabels[name] = word;
		}
		return {
			kind,
			label: data.label,
			owner: data.owner,
			actions: [...data.actions],
			defaultAction: data.defaultAction,
			actionLabels,
		};
	});
}

/** The resource kinds a toolchain's results create, by kind id. */
export function producesInTransaction(
	db: Database,
	toolchainId: string,
): string[] {
	return activeKinds(db)
		.filter((item) => item.data.producedBy.includes(toolchainId))
		.map((item) => item.kind);
}

/** Every toolchain id that produces at least one kind, with its kinds. */
export function producersInTransaction(db: Database): Map<string, string[]> {
	const producers = new Map<string, string[]>();
	for (const { kind, data } of activeKinds(db))
		for (const toolchainId of data.producedBy)
			producers.set(toolchainId, [...(producers.get(toolchainId) ?? []), kind]);
	return producers;
}
