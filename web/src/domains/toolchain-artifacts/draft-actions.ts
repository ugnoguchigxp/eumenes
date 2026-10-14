import type { ArtifactEvent, Receipt } from "@eumenes/artifact-ui/contracts";
import { useCallback, type MutableRefObject } from "react";
import type { ActionBindingV1 } from "../../../../api/domains/capabilities/contracts";
import type { ArtifactDefinitionV1 } from "../../../../api/domains/capabilities/contracts";
import type { EumenesClient } from "../../../../client";
import type { ActionDispatcher } from "./dispatcher";
import { dirtyEntries, equalsSaved, parseWire, toWire } from "./documents";
import { draftStoreFor, entryKey, splitEntryKey } from "./drafts";
import { pendingMessage, receiptOf, unsettledMessage } from "./messages";
import { DELETE_SUFFIX, SECRET_MASK } from "./drafts";
import type { GetLatest } from "./screen-state";

/** What the user did to a masked secret field: appended, deleted from the end, or replaced. */
export function nextSecret(current: string, shown: string): string {
	const mask = SECRET_MASK.repeat(current.length);
	if (shown.startsWith(mask)) return current + shown.slice(mask.length);
	const dots = shown.length - shown.replaceAll(SECRET_MASK, "").length;
	if (dots === shown.length) return current.slice(0, dots);
	const lead = /^•*/.exec(shown)![0].length;
	return current.slice(0, lead) + shown.slice(lead).replaceAll(SECRET_MASK, "");
}

type Describe = (
	code: string | undefined,
	fieldErrors: ReadonlyArray<{ field: string; message: string }>,
) => string;

/**
 * The shared-draft actions of a screen: an edit or a discard (local, checked against the
 * registered field), and the apply that freezes the dirty entries and sends them as one
 * operation.
 */
export function useDraftActions({
	client,
	artifact,
	getLatest,
	dispatcherRef,
	describe,
}: {
	client: EumenesClient;
	artifact: ArtifactDefinitionV1;
	getLatest: GetLatest;
	dispatcherRef: MutableRefObject<ActionDispatcher | null>;
	describe: Describe;
}) {
	/** An edit or a discard of the shared draft: local, checked against the registered field. */
	const draftAction = useCallback(
		(binding: ActionBindingV1, event: ArtifactEvent): Receipt => {
			const { state: s, documentFields: all } = getLatest();
			const doc = binding.draftDocument!;
			const store = draftStoreFor(client.identity, doc);
			const accepted: Receipt = { status: "accepted", message: "" };
			if (binding.draftAction === "discard") {
				if (Object.keys(event.values).length)
					return { status: "rejected", message: "入力を確認してください" };
				return store.discard()
					? accepted
					: { status: "rejected", message: "適用中です" };
			}
			const keys = Object.keys(event.values).sort().join(",");
			if (keys !== "fieldId,value" || typeof event.values.fieldId !== "string")
				return { status: "rejected", message: "入力を確認してください" };
			const key = event.values.fieldId;
			if (key.endsWith(DELETE_SUFFIX)) {
				// The switch of a secret field that may be unset: delete the stored secret.
				const base = splitEntryKey(key.slice(0, -DELETE_SUFFIX.length));
				const target = (all[doc] ?? []).find(
					(f) =>
						f.fieldId === base.fieldId &&
						f.confidential &&
						f.unset &&
						artifact.fields?.some((o) => o.fieldId === f.fieldId),
				);
				const wire = event.values.value;
				if (!target || (wire !== "true" && wire !== "false"))
					return { status: "rejected", message: "未登録の設定項目です" };
				if (wire === "true")
					store.set({
						fieldId: base.fieldId,
						...(base.target ? { target: base.target } : {}),
						change: { unset: true },
						confidential: true,
					});
				else store.remove(base.fieldId, base.target);
				return accepted;
			}
			const handled = s.editLocal?.(key, String(event.values.value));
			if (handled) return handled;
			const access = s.documents?.[doc];
			const { fieldId, target } = splitEntryKey(key);
			// Only fields this screen registered can be edited from it.
			const own = artifact.fields?.some(
				(f) => f.document === doc && f.fieldId === fieldId,
			);
			const field = own
				? (all[doc] ?? []).find((f) => f.fieldId === fieldId)
				: undefined;
			if (!field || !access?.ready)
				return { status: "rejected", message: "未登録の設定項目です" };
			if (
				field.target
					? !target || !access.targets(field).some((t) => t.id === target)
					: target !== undefined
			)
				return { status: "rejected", message: "未登録の設定項目です" };
			const rule = access.rule(field, target);
			if (!rule || rule.disabled)
				return { status: "rejected", message: "この設定項目は操作できません" };
			// A secret field shows only a mask of its length, so the text of an edit is read as
			// a change to the secret held in memory. Emptying it keeps the stored secret.
			if (field.confidential && typeof event.values.value === "string") {
				const next = nextSecret(
					store.peekSecret(field.fieldId, target),
					event.values.value,
				);
				if (next === "") {
					store.remove(field.fieldId, target);
					return accepted;
				}
				store.set({
					fieldId: field.fieldId,
					...(target ? { target } : {}),
					change: { value: next },
					confidential: true,
				});
				return accepted;
			}
			const parsed = parseWire(field, rule, event.values.value);
			if (!parsed.ok) return { status: "rejected", message: parsed.message };
			const apply = (
				f: typeof field,
				t: string | undefined,
				change: typeof parsed.change,
			) => {
				if (!f.confidential && equalsSaved(change, access.read(f, t)))
					store.remove(f.fieldId, t);
				else
					store.set({
						fieldId: f.fieldId,
						...(t ? { target: t } : {}),
						change,
						...(f.confidential ? { confidential: true } : {}),
					});
			};
			apply(field, target, parsed.change);
			for (const next of access.derive?.(field, target, parsed.change) ?? []) {
				const related = (all[doc] ?? []).find((f) => f.path === next.path);
				if (related && (!related.target || target))
					apply(related, related.target ? target : undefined, next.change);
			}
			return accepted;
		},
		[client.identity, artifact, getLatest],
	);

	/**
	 * Applies the shared draft as one operation: the dirty entries are frozen, sent as the
	 * registered action's input, and only what was sent leaves the draft once it is settled.
	 */
	const applyDraft = useCallback(
		async (
			binding: ActionBindingV1,
			event: ArtifactEvent,
		): Promise<Receipt> => {
			const { state: s, snapshot: shown, documentFields: all } = getLatest();
			const doc = binding.draftDocument!;
			const store = draftStoreFor(client.identity, doc);
			const access = s.documents?.[doc];
			const dispatcher = dispatcherRef.current;
			const refused = (text: string): Receipt => {
				store.setMessage(text);
				return { status: "rejected", message: "" };
			};
			if (!access?.ready || !dispatcher || Object.keys(event.values).length)
				return {
					status: "rejected",
					message: "変更を適用できる状態ではありません",
				};
			if (store.getView().busy) return refused("適用中です");
			const dirty = new Set(
				dirtyEntries(store.getView(), all[doc] ?? [], access).map(({ entry }) =>
					entryKey(entry.fieldId, entry.target),
				),
			);
			store.prune(
				(entry) =>
					entry.confidential ||
					dirty.has(entryKey(entry.fieldId, entry.target)),
			);
			// Operations the user must confirm (a changed origin) travel as structure, last.
			const confirmed: Array<{
				structure: string;
				input: Record<string, unknown>;
			}> = [];
			for (const need of access.confirmations?.(
				dirtyEntries(store.getView(), all[doc] ?? [], access),
			) ?? []) {
				if (!window.confirm(need.prompt)) return refused(need.declined);
				confirmed.push({ structure: need.structure, input: need.input });
			}
			const frozen = store.freeze(() => true);
			if (!frozen) return refused("適用できる変更がありません");
			// The wire carries strings: booleans "true"/"false", numbers decimal, lists as JSON.
			const changes = frozen.entries
				.filter((e) => !e.confidential)
				.map((e) => ({
					fieldId: e.fieldId,
					...(e.target ? { target: e.target } : {}),
					...("unset" in e.change
						? { unset: true }
						: { value: toWire(e.change.value) }),
				}));
			// Secrets travel apart from the changes, by the id of the array element they belong to.
			const keys = frozen.entries
				.filter((e) => e.confidential)
				.map((e) => ({
					connectionId: e.target ?? e.fieldId,
					...("unset" in e.change
						? { delete: true }
						: { value: toWire(e.change.value) }),
				}));
			const structural = [
				...frozen.structural.map(({ structure, input }) => ({
					structure,
					input,
				})),
				...confirmed,
			];
			const input = {
				expectedRevision: access.revision,
				...(structural.length ? { structural } : {}),
				changes,
				...(keys.length ? { keys } : {}),
			};
			// Any secret in the draft keeps the whole send out of the outbox, whatever the
			// binding declares: a missing declaration must not become a stored secret.
			const confidential =
				keys.length > 0 ||
				!!binding.confidentialFields?.some((name) => name in input);
			const timing = { sent: performance.now(), sentAt: Date.now() };
			const outcome = await dispatcher.send({
				actionId: binding.actionId,
				source: binding.source,
				sourceRevision: shown[binding.source]?.revision ?? event.revision,
				targetRef: undefined,
				input,
				persist: !confidential,
			});
			if (outcome.kind === "accepted") {
				// Read the saved document again before the draft lets go of what it sent.
				if (outcome.result)
					await s.settled(binding, outcome.result, timing, input);
				store.settle(frozen, "applied");
				store.setMessage("変更を適用しました");
				return { status: "accepted", message: "" };
			}
			store.settle(frozen, "kept", {
				dropSecrets: confidential && outcome.kind !== "rejected",
			});
			if (outcome.kind === "rejected") {
				if (outcome.conflict) s.refresh();
				store.setMessage(
					outcome.conflict
						? "別の画面で設定が変更されました。最新の設定を読み直してから適用してください。"
						: `適用できませんでした: ${describe(outcome.code, outcome.fieldErrors)}`,
				);
				return {
					status: outcome.conflict ? "conflict" : "rejected",
					message: "",
				};
			}
			store.setMessage(
				confidential
					? "結果を確認できませんでした。認証情報を再入力して適用し直してください。"
					: outcome.kind === "pending"
						? pendingMessage
						: unsettledMessage,
			);
			// The wording lives in the draft's message; the receipt only carries the state.
			return { ...receiptOf(outcome, describe), message: "" };
		},
		[client.identity, describe, getLatest, dispatcherRef],
	);
	return { draftAction, applyDraft };
}
