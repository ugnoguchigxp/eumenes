import type { CollectionResource } from "@eumenes/artifact-ui";
import type { ArtifactDefinitionV1 } from "../../../../api/domains/capabilities/contracts";
import type { DraftView } from "./drafts";
import { formatCollectionValue, getPath } from "./collections";

/** Project staged additions into the registered columns, without inventing saved domain values. */
export function withDraftRows(
	source: string,
	resource: CollectionResource,
	artifact: ArtifactDefinitionV1,
	drafts: Readonly<Record<string, DraftView>>,
): CollectionResource {
	const collection = artifact.collections?.find((c) => c.source === source);
	const binding = artifact.actionBindings.find(
		(b) =>
			b.actionId === collection?.create?.actionId &&
			b.draftAction === "structure",
	);
	if (!collection || !binding?.draftDocument) return resource;
	const status = "$draft-status";
	const pending = (drafts[binding.draftDocument]?.structural ?? [])
		.filter(
			(s) =>
				s.structure === binding.structure &&
				!resource.rows.some((r) => r.id === s.created),
		)
		.map((entry) => ({
			id: entry.created ?? entry.id,
			cells: {
				...Object.fromEntries(
					collection.columns.map((column, index) => {
						const fieldId = collection.create?.preview?.[column.key];
						const value = fieldId
							? entry.input[fieldId]
							: getPath(entry.input, column.key);
						return [
							column.key,
							value === undefined && index === 0
								? entry.label
								: formatCollectionValue(value, column.format),
						];
					}),
				),
				[status]: "未保存",
			},
			// The backend cannot operate on an element that has not been saved yet.
			actions: [],
		}));
	return {
		...resource,
		columns: [...resource.columns, { key: status, label: "保存状態" }],
		rows: [
			...pending,
			...resource.rows.map((row) => ({
				...row,
				cells: { ...row.cells, [status]: "保存済み" },
			})),
		],
		total: resource.total + pending.length,
	};
}
