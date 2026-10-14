import type { ArtifactEvent, Receipt } from "@eumenes/artifact-ui/contracts";
import { useCallback, type MutableRefObject } from "react";
import type { ArtifactDefinitionV1 } from "../../../../api/domains/capabilities/contracts";
import type { EumenesClient } from "../../../../client";
import {
	createdId,
	findRow,
	parseForm,
	rowInput,
	withOptions,
	type PagingQuery,
} from "./collections";
import type { ActionDispatcher } from "./dispatcher";
import { draftStoreFor } from "./drafts";
import { receiptOf } from "./messages";
import type { GetLatest } from "./screen-state";
import type { Collections } from "./use-collections";

type Describe = (
	code: string | undefined,
	fieldErrors: ReadonlyArray<{ field: string; message: string }>,
) => string;

const refuse = (message: string): Receipt => ({ status: "rejected", message });

/**
 * Events of a registered collection: another page, a row action, or the create form. A row
 * action sends the registered write with an input built from the row the host holds; a create
 * or removal that changes a document's structure is staged in the shared draft instead.
 * Secrets of a form follow the draft's secret rules (memory only, count in the review).
 */
export function useCollectionActions({
	client,
	artifact,
	collections,
	getLatest,
	dispatcherRef,
	describe,
	reveal,
}: {
	client: EumenesClient;
	artifact: ArtifactDefinitionV1;
	collections: Collections;
	getLatest: GetLatest;
	dispatcherRef: MutableRefObject<ActionDispatcher | null>;
	describe: Describe;
	/** A settled write returned a value to show once (never stored). */
	reveal: (receipt: unknown) => void;
}) {
	const handle = useCallback(
		async (event: ArtifactEvent): Promise<Receipt> => {
			const collection = collections.collections.find(
				(c) => c.source === event.source,
			);
			if (!collection) return refuse("この操作は利用できません");
			const current = getLatest().snapshot[event.source];
			if (current && current.revision !== event.revision)
				return {
					status: "conflict",
					message: "一覧が更新されています。最新の表示から操作してください。",
				};
			if (event.action === "collection-page") {
				if (!collection.paging) return refuse("この一覧は切り替えられません");
				const v = event.values;
				const query: PagingQuery = {
					pageIndex: Number(v.pageIndex),
					pageSize: Number(v.pageSize),
					sort: String(v.sort ?? ""),
					desc: v.desc === true,
					q: String(v.q ?? ""),
				};
				if (
					!Number.isInteger(query.pageIndex) ||
					query.pageIndex < 0 ||
					![10, 25, 50].includes(query.pageSize)
				)
					return refuse("表の条件を確認してください");
				collections.page(event.source, query);
				return { status: "accepted", message: "" };
			}
			const isCreate = event.action === "collection-create";
			const actionId = String(event.values.actionId ?? "");
			const registered = isCreate
				? collection.create?.actionId === actionId
				: collection.rowActions.some((a) => a.actionId === actionId);
			const binding = artifact.actionBindings.find(
				(b) => b.actionId === actionId,
			);
			if (!registered || !binding) return refuse("この操作は利用できません");
			// The row is the one the host holds; the event only names its id.
			let input: Record<string, unknown> = {};
			let secrets: Array<{ fieldId: string; value: unknown }> = [];
			const rowAction = isCreate
				? undefined
				: collection.rowActions.find((a) => a.actionId === actionId);
			const form = withOptions(
				(isCreate ? collection.create!.fields : rowAction?.form?.fields) ?? [],
				collections.formOptions,
			);
			let row: unknown = {};
			if (!isCreate) {
				row = findRow(
					collection,
					collections.data[collection.source],
					String(event.values.rowId ?? ""),
				);
				if (row === undefined)
					return refuse("対象が見つかりません。一覧を更新してください。");
			}
			input = rowInput(binding, row);
			if (form.length > 0) {
				const parsed = parseForm(form, event.values);
				if (!parsed.ok) return refuse(parsed.message);
				const confidentialIds = new Set(
					form
						.filter((f) => f.confidential || f.control === "secret")
						.map((f) => f.fieldId),
				);
				secrets = Object.entries(parsed.values)
					.filter(([id]) => confidentialIds.has(id))
					.map(([fieldId, value]) => ({ fieldId, value }));
				// Form values join the registered row input; a structure keeps secrets apart.
				input = {
					...input,
					...Object.fromEntries(
						Object.entries(parsed.values).filter(
							([id]) =>
								binding.draftAction !== "structure" || !confidentialIds.has(id),
						),
					),
				};
			}
			if (binding.effect === "draft" && binding.draftAction === "structure") {
				const store = draftStoreFor(client.identity, binding.draftDocument!);
				const target = createdId(binding, input);
				store.stage({
					id: crypto.randomUUID(),
					structure: binding.structure!,
					input,
					...(target ? { created: target } : {}),
					label:
						(binding.label ?? binding.actionId) +
						(typeof input.name === "string" ? `（${input.name}）` : ""),
				});
				// Secrets stay in the draft's memory, keyed by the element the structure creates.
				for (const secret of secrets)
					store.set({
						fieldId: secret.fieldId,
						...(target ? { target } : {}),
						change: { value: secret.value as string },
						confidential: true,
					});
				return { status: "accepted", message: "" };
			}
			const dispatcher = dispatcherRef.current;
			if (binding.effect !== "write" || !dispatcher)
				return refuse("この操作は利用できません");
			const timing = { sent: performance.now(), sentAt: Date.now() };
			const secret =
				secrets.length > 0 ||
				!!binding.confidentialFields?.some((name) => name in input);
			const outcome = await dispatcher.send({
				actionId: binding.actionId,
				source: binding.source,
				sourceRevision: current?.revision ?? event.revision,
				targetRef: undefined,
				input,
				persist: !secret,
			});
			if (outcome.kind === "accepted") {
				if (outcome.result) {
					await getLatest().state.settled(
						binding,
						outcome.result,
						timing,
						input,
					);
					reveal(outcome.result.receipt);
				}
				collections.reload();
			} else if (outcome.kind === "rejected" && outcome.conflict) {
				getLatest().state.refresh();
				collections.reload();
			}
			return receiptOf(outcome, describe);
		},
		[
			client.identity,
			artifact,
			collections,
			getLatest,
			dispatcherRef,
			describe,
			reveal,
		],
	);
	// Other events stay synchronous: the draft edits of a form must apply in the same tick.
	return useCallback(
		(event: ArtifactEvent): Promise<Receipt> | null =>
			event.action.startsWith("collection-") ? handle(event) : null,
		[handle],
	);
}
