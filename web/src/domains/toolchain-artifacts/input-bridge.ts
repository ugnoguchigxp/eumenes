import { useCallback } from "react";
import type { Snapshot } from "@eumenes/artifact-ui";
import type { ArtifactDefinitionV1 } from "../../../../api/domains/capabilities/contracts";
import {
	DELETE_SUFFIX,
	draftStoreFor,
	splitEntryKey,
	type DraftView,
} from "./drafts";

/** Private editor state joins the existing document draft; snapshots contain no input values. */
export function useInputBridge(
	identity: string,
	artifactId: string,
	artifact: ArtifactDefinitionV1,
) {
	const documentOf = useCallback(
		(source: string) => {
			const create = artifact.collections?.find((c) => c.source === source)
				?.create?.actionId;
			return artifact.actionBindings.find(
				(b) =>
					b.draftDocument && (b.source === source || b.actionId === create),
			)?.draftDocument;
		},
		[artifact],
	);
	const setEditing = useCallback(
		(source: string, id: string, message: string | null) => {
			const document = documentOf(source);
			if (document)
				draftStoreFor(identity, document).setEditing(
					`${artifactId}:${source}:${id}`,
					message,
				);
		},
		[identity, artifactId, documentOf],
	);
	const readSecret = useCallback(
		(source: string, key: string) => {
			if (key.endsWith(DELETE_SUFFIX)) return undefined;
			const document = documentOf(source);
			const { fieldId, target } = splitEntryKey(key);
			if (
				!document ||
				!artifact.fields?.some(
					(f) =>
						f.document === document && f.fieldId === fieldId && f.confidential,
				)
			)
				return undefined;
			return draftStoreFor(identity, document).peekSecret(fieldId, target);
		},
		[identity, artifact, documentOf],
	);
	return { setEditing, readSecret };
}

export function withEditingState(
	snapshot: Snapshot,
	artifact: ArtifactDefinitionV1,
	drafts: Readonly<Record<string, DraftView>>,
): Snapshot {
	return Object.fromEntries(
		Object.entries(snapshot).map(([source, resource]) => {
			if (
				![
					"settings-section",
					"settings-changes",
					"settings-navigation",
				].includes(resource.kind)
			)
				return [source, resource];
			const documents = new Set(
				artifact.actionBindings
					.filter((b) => b.source === source)
					.flatMap((b) => (b.draftDocument ? [b.draftDocument] : [])),
			);
			const editors = [...documents].flatMap(
				(doc) => drafts[doc]?.editors ?? [],
			);
			return [
				source,
				editors.length
					? {
							...resource,
							dirty: true,
							blocked: true,
							message: editors.map((e) => e.message).join("\n"),
						}
					: resource,
			];
		}),
	);
}
