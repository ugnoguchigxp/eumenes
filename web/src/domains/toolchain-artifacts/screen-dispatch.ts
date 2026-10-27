import type { ArtifactEvent, Receipt } from "@eumenes/artifact-ui/contracts";
import { useCallback, type MutableRefObject } from "react";
import type {
	ActionBindingV1,
	ArtifactDefinitionV1,
} from "../../../../api/domains/capabilities/contracts";
import type { EumenesClient } from "../../../../client";
import type { useCollectionActions } from "./collection-actions";
import type { ActionDispatcher, ActionOutcome } from "./dispatcher";
import type { useDraftActions } from "./draft-actions";
import { draftStoreFor } from "./drafts";
import { receiptOf } from "./messages";
import { navigationDestination } from "./navigation";
import type { useAnswer } from "./questions";
import type { GetLatest } from "./screen-state";

/**
 * The event's binding: the one registered for this event and source (a registration holds at
 * most one), else the only binding of that event. Panels with several actions register one
 * binding and name the action in the event's `id` value.
 */
export function findActionBinding(
	bindings: readonly ActionBindingV1[],
	event: Pick<ArtifactEvent, "action" | "source">,
): ActionBindingV1 | undefined {
	const exact = bindings.find(
		(b) => b.eventAction === event.action && b.source === event.source,
	);
	if (exact) return exact;
	const same = bindings.filter((b) => b.eventAction === event.action);
	return same.length === 1 ? same[0] : undefined;
}

/**
 * Routes every event of a screen: collection and source reads, local, draft, navigate, answer
 * and apply actions are handled here; a registered write goes through the dispatcher (outbox).
 */
export function useScreenDispatch({
	client,
	artifact,
	documents,
	getLatest,
	collectionEvent,
	draftAction,
	applyDraft,
	answer,
	describe,
	dispatcherRef,
	reveal,
	onNavigate,
}: {
	client: EumenesClient;
	artifact: ArtifactDefinitionV1;
	documents: ReadonlyArray<string>;
	getLatest: GetLatest;
	collectionEvent: ReturnType<typeof useCollectionActions>;
	draftAction: ReturnType<typeof useDraftActions>["draftAction"];
	applyDraft: ReturnType<typeof useDraftActions>["applyDraft"];
	answer: ReturnType<typeof useAnswer>;
	describe: Parameters<typeof receiptOf>[1];
	dispatcherRef: MutableRefObject<ActionDispatcher | null>;
	/** A settled write returned a value to show once (never stored). */
	reveal: (receipt: unknown) => void;
	onNavigate?: (artifactId: string) => Promise<boolean> | boolean;
}) {
	return useCallback(
		async (event: ArtifactEvent): Promise<Receipt> => {
			const { state: s, snapshot: shown } = getLatest();
			const collection = collectionEvent(event);
			if (collection) return collection;
			const binding = findActionBinding(artifact.actionBindings, event);
			if (!binding)
				return (
					s.sourceRead?.(event) ?? {
						status: "rejected",
						message: "この操作は利用できません",
					}
				);
			const current = shown[event.source];
			if (current && current.revision !== event.revision)
				return {
					status: "conflict",
					message: "状態が変わりました。もう一度お試しください。",
				};
			if (binding.effect === "local") return s.local(binding, event);
			if (binding.effect === "draft") return draftAction(binding, event);
			if (binding.effect === "navigate") {
				if (event.action === "settings-review") {
					const editors = documents.flatMap(
						(doc) =>
							draftStoreFor(client.identity, doc).getView().editors ?? [],
					);
					if (editors.length)
						return {
							status: "rejected",
							message: editors.map((e) => e.message).join("\n"),
						};
				}
				const destination = navigationDestination(binding, event.values);
				const opened = destination ? await onNavigate?.(destination) : false;
				return opened
					? { status: "accepted", message: "" }
					: { status: "rejected", message: "この画面は現在利用できません" };
			}
			if (binding.answer) return answer(event);
			if (binding.draftDocument) return applyDraft(binding, event);
			const timing = { sent: performance.now(), sentAt: Date.now() };
			const dispatcher = dispatcherRef.current;
			if (!dispatcher)
				return { status: "rejected", message: "画面を準備しています。" };
			const outcome: ActionOutcome = await dispatcher.send({
				actionId: binding.actionId,
				source: binding.source,
				sourceRevision: shown[binding.source]?.revision ?? event.revision,
				targetRef: s.targetOf(binding.source),
				input: event.values,
			});
			if (outcome.kind === "accepted" && outcome.result) {
				// A one-time value is shown before anything else can fail.
				reveal(outcome.result.receipt);
				s.settled(binding, outcome.result, timing, event.values);
			}
			if (outcome.kind === "rejected" && outcome.conflict) s.refresh();
			return receiptOf(outcome, describe);
		},
		[
			getLatest,
			artifact,
			documents,
			client.identity,
			answer,
			describe,
			draftAction,
			applyDraft,
			onNavigate,
			dispatcherRef,
			collectionEvent,
			reveal,
		],
	);
}
