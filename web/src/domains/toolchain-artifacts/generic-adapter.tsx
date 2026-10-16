import type { Resource, Snapshot } from "@eumenes/artifact-ui";
import { useQuery } from "@tanstack/react-query";
import { queryRoots } from "../../queryKeys";
import {
	dirtyEntries,
	reviewRows,
	ruleOf,
	toWire,
	type DocumentAccess,
	type RegisteredField,
} from "./documents";
import { SECRET_MASK, type DraftEntry } from "./drafts";
import { artifactIdOf, entryLabel } from "./launcher";
import { navigationTargets } from "./navigation";
import { readPath, writePath } from "./paths";
import type {
	AdapterHostContext,
	AdapterState,
	WebArtifactAdapter,
} from "./registry";

/** Stands for every adapterRef that has no domain Web adapter. */
const GENERIC_ADAPTER_REF = "*";

const emptyAccess = (): DocumentAccess => ({
	ready: false,
	revision: 0,
	read: () => undefined,
	rule: () => null,
	targets: () => [],
});

/**
 * The adapter of every domain without special UI. Lists and their actions are built by the host
 * from the registration; this adds the document fields of a screen (a few toggles), the change
 * review and a hub of navigate bindings. The saved document is the data of the artifact's first
 * source that is not a list (`{ revision, data }`, paths resolved inside `data`).
 */
function useGenericArtifact(context: AdapterHostContext): AdapterState {
	const { client, artifact, artifactRevisionId, drafts, documentFields } =
		context;
	const listSources = new Set(
		(artifact.collections ?? []).map((c) => c.source),
	);
	const documentSource = artifact.sourceBindings.find(
		(s) => !listSources.has(s.source),
	)?.source;
	const own = (artifact.fields ?? []) as RegisteredField[];
	const documentEnabled =
		!!documentSource && (own.length > 0 || hasChangesView(artifact));
	const document = useQuery({
		queryKey: [
			queryRoots.toolchainArtifacts,
			client.identity,
			"document",
			artifactRevisionId,
		],
		queryFn: ({ signal }) =>
			client.toolchainArtifactSource(
				artifactRevisionId,
				documentSource!,
				undefined,
				signal,
			),
		enabled: documentEnabled,
		retry: false,
	});
	const documents: Record<string, DocumentAccess> = {};
	for (const ref of new Set(
		[...own, ...Object.values(documentFields).flat()].map((f) => f.document),
	)) {
		const saved = document.data?.data;
		documents[ref] = saved
			? {
					ready: true,
					revision: document.data!.revision,
					read: (field, target) => readPath(saved, field.path, target),
					rule: (field) => ruleOf(field),
					targets: () => [],
				}
			: emptyAccess();
	}
	const apply = (
		entries: ReadonlyArray<DraftEntry>,
		fields: ReadonlyArray<RegisteredField>,
	) => {
		const data = document.data?.data;
		if (!data) return undefined;
		const next = structuredClone(data) as Record<string, unknown>;
		for (const entry of entries) {
			const field = fields.find((f) => f.fieldId === entry.fieldId);
			if (field) writePath(next, field.path, entry.target, entry.change);
		}
		return next;
	};

	const snapshot: Record<string, Resource> = {};
	const bindings = artifact.actionBindings;
	for (const [ref, access] of Object.entries(documents)) {
		const view = drafts[ref];
		const all = documentFields[ref] ?? [];
		if (!view || !access.ready) continue;
		const revision = access.revision * 1_000_000 + view.version;
		const dirty =
			dirtyEntries(view, all, access).length > 0 ||
			view.structural.length > 0 ||
			view.secrets.length > 0;
		const effective = apply(view.entries, all);
		for (const source of bindings
			.filter(
				(b) =>
					b.effect === "draft" &&
					b.draftAction === "edit" &&
					b.draftDocument === ref,
			)
			.map((b) => b.source))
			snapshot[source] = {
				kind: "settings-section",
				revision,
				dirty,
				busy: view.busy,
				blocked: false,
				message: view.message,
				fields: own
					.filter((f) => f.document === ref)
					.flatMap((field) => {
						const rule = ruleOf(field);
						return field.target
							? []
							: [
									{
										id: field.fieldId,
										label: field.label,
										...(field.help ? { help: field.help } : {}),
										control: field.control,
										value: field.confidential
											? SECRET_MASK.repeat(
													view.secrets.find((x) => x.fieldId === field.fieldId)
														?.length ?? 0,
												)
											: toWire(readPath(effective, field.path)),
										...(rule.defaultValue !== undefined
											? { defaultValue: rule.defaultValue }
											: {}),
										...(rule.options ? { options: [...rule.options] } : {}),
										...(rule.min !== undefined ? { minimum: rule.min } : {}),
										...(rule.max !== undefined ? { maximum: rule.max } : {}),
										...(rule.step ? { step: rule.step } : {}),
										...(rule.maxLength ? { maxLength: rule.maxLength } : {}),
										...(field.group ? { group: field.group } : {}),
										...(field.detail ? { detail: true } : {}),
									},
								];
					}),
			};
		for (const source of bindings
			.filter(
				(b) =>
					b.effect === "draft" &&
					b.draftAction === "discard" &&
					b.draftDocument === ref,
			)
			.map((b) => b.source))
			snapshot[source] = {
				kind: "settings-changes",
				revision,
				dirty,
				busy: view.busy,
				blocked: false,
				message: view.message,
				rows: reviewRows(view, all, access, context.documentFieldsReady),
			};
	}
	// A hub: the navigate bindings of a "settings-open" event, labelled by their targets.
	for (const binding of bindings.filter(
		(b) => b.effect === "navigate" && b.eventAction === "settings-open",
	))
		snapshot[binding.source] = {
			kind: "settings-navigation",
			revision: 0,
			dirty: Object.entries(drafts).some(
				([ref, view]) =>
					dirtyEntries(view, documentFields[ref] ?? [], documents[ref]).length >
						0 ||
					view.structural.length > 0 ||
					view.secrets.length > 0,
			),
			entries: navigationTargets(binding).map((target) => {
				const entry = context.catalog.find(
					(e) => artifactIdOf(e.artifactRevisionId) === target.artifactId,
				);
				return {
					id: target.id,
					label: entry ? entryLabel(entry) : target.id,
					...(entry?.launcher?.description
						? { description: entry.launcher.description }
						: {}),
					group: entry?.launcher?.group ?? "その他",
					enabled: !!entry,
				};
			}),
		};

	return {
		phase: document.isError
			? { kind: "error", message: "画面のデータを読み込めません。" }
			: { kind: "ready" },
		snapshot: snapshot as Snapshot,
		targetOf: () => undefined,
		local: async () => ({
			status: "rejected",
			message: "この操作は利用できません",
		}),
		// The host reads its lists again after a settled write; the document is read here.
		// Only a screen with a document source has a document to read again.
		settled: async () => {
			if (documentEnabled) await document.refetch();
		},
		refresh: () => {
			if (documentEnabled) void document.refetch();
		},
		documents,
	};
}

const hasChangesView = (artifact: AdapterHostContext["artifact"]) =>
	artifact.actionBindings.some((b) => b.draftAction === "discard");

export const genericWebAdapter: WebArtifactAdapter = {
	adapterRef: GENERIC_ADAPTER_REF,
	useArtifact: useGenericArtifact,
};
