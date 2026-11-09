import { useId, useMemo, useState } from "react";
import { Feedback, useAction } from "./action";
import { listRefreshSource } from "./composition-contracts";
import type { Snapshot, UiStudioResource } from "./contracts";
import { ArtifactRenderer } from "./index";
import { type ArtifactRuntime, useArtifactRuntime } from "./runtime";
import {
	hasForm,
	savedFormSource,
	savedPreview,
	trialFormSource,
	trialPreview,
} from "./ui-studio-preview";
import {
	AppStorageRecords,
	storageDefaults,
	storageRecordValues,
} from "./ui-studio-storage";
import { displayWorkflowOutput } from "./ui-studio-workflow-output";
import type { AppStorageRecord } from "./ui-studio-contracts";

type Device = "desktop" | "mobile";
type AppViewing = NonNullable<UiStudioResource["viewing"]>;

const trialMessage = "試用です。回答は保存されません。";

/** The draft or a saved work, rendered as a composition (a draft's form is a trial). */
export function StudioPreview({
	definition,
	saved,
	device,
	app,
}: {
	definition: unknown;
	saved: boolean;
	device: Device;
	app?: AppViewing;
}) {
	const runtime = useArtifactRuntime();
	const storageAction = useAction({ view: "ui-studio", source: "ui-studio" });
	const [selected, setSelected] = useState<AppStorageRecord | null>(null);
	const [reset, setReset] = useState(0);
	const storage = app?.storage;
	const savedForm = runtime.snapshot[savedFormSource];
	const workflow = app?.workflow;
	const bindings = app?.bindings;
	const appIdentity = app && `${app.id}:${app.savedRevision}`;
	const formId = useId();
	const listRefresh =
		workflow?.publish?.schemaRef === "schema:showtimes.rows@1" &&
		!!(bindings?.sections ?? bindings?.table) &&
		Object.keys(bindings.inputs).length > 0;
	const updating = ["accepted", "running", "publishing"].includes(
		app?.status?.state ?? "",
	);
	const prepared = useMemo(() => {
		const preview = app ? displayWorkflowOutput(app, listRefresh) : definition;
		return saved
			? { definition: savedPreview(preview), form: null }
			: trialPreview(preview);
	}, [app, definition, listRefresh, saved]);
	const snapshot = useMemo<Snapshot>(
		() => ({
			...(prepared.form
				? {
						[trialFormSource]: storage
							? {
									...prepared.form,
									identity: `${appIdentity}:${selected?.id ?? "new"}:${selected?.revision ?? reset}`,
									defaults: storageDefaults(storage, prepared.form, selected),
									submitLabel: selected ? "変更を保存" : "記録を追加",
									disabled:
										!!storage.error ||
										!storage.operations.includes(
											selected ? "update" : "create",
										),
								}
							: workflow
								? {
										...prepared.form,
										identity: appIdentity,
										submitLabel: "更新",
										...(listRefresh ? { externalSubmitId: formId } : {}),
									}
								: prepared.form,
					}
				: {}),
			...(listRefresh && prepared.form
				? {
						[listRefreshSource]: {
							kind: "form",
							revision: 0,
							submitLabel: "作品リストを更新",
							submitForm: formId,
							disabled: updating,
							fields: [],
							defaults: {},
						},
					}
				: {}),
			...(saved && savedForm ? { [savedFormSource]: savedForm } : {}),
		}),
		[
			prepared.form,
			saved,
			savedForm,
			workflow,
			appIdentity,
			formId,
			listRefresh,
			updating,
			storage,
			selected,
			reset,
		],
	);
	const previewRuntime = useMemo<ArtifactRuntime>(
		() => ({
			...runtime,
			snapshot,
			dispatch: async (event) => {
				if (event.source === trialFormSource && app && storage) {
					const values = storageRecordValues(storage, event.values, selected);
					const receipt = await runtime.dispatch({
						...event,
						revision: runtime.snapshot["ui-studio"]?.revision ?? event.revision,
						source: "ui-studio",
						action: "ui-storage-record",
						values: {
							appId: app.id,
							revision: String(app.savedRevision),
							collection: storage.collection,
							record: JSON.stringify(
								selected
									? {
											operation: "update",
											id: selected.id,
											expectedRevision: selected.revision,
											values,
										}
									: { operation: "create", values },
							),
						},
					});
					if (receipt.status === "accepted") {
						setSelected(null);
						setReset((count) => count + 1);
					}
					return receipt;
				}
				return event.source === trialFormSource && app?.workflow && app.bindings
					? runtime.dispatch({
							...event,
							revision:
								runtime.snapshot["ui-studio"]?.revision ?? event.revision,
							source: "ui-studio",
							action: "ui-workflow-run",
							values: {
								appId: app.id,
								revision: String(app.savedRevision),
								values: JSON.stringify(
									Object.fromEntries(
										Object.entries(event.values).flatMap(([field, value]) =>
											Object.hasOwn(app.bindings!.inputs, field)
												? [[app.bindings!.inputs[field], value]]
												: [],
										),
									),
								),
							},
						})
					: event.source === trialFormSource
						? Promise.resolve({ status: "accepted", message: trialMessage })
						: runtime.dispatch(event);
			},
		}),
		[runtime, snapshot, app, storage, selected],
	);
	const text = useMemo(
		() => JSON.stringify(prepared.definition),
		[prepared.definition],
	);
	const waitingForm =
		saved && hasForm(definition) && !savedForm
			? "回答フォームを読み込んでいます"
			: null;
	return (
		<div className={`aui-ui-preview-canvas aui-ui-preview-${device}`}>
			{waitingForm ? (
				<div className="aui-ui-preview-empty">
					<output>{waitingForm}</output>
				</div>
			) : (
				<ArtifactRenderer definition={text} runtime={previewRuntime} />
			)}
			{app && storage && (
				<AppStorageRecords
					appId={app.id}
					revision={app.savedRevision}
					storage={storage}
					selected={selected}
					onSelect={setSelected}
					pending={storageAction.pending}
					send={(event, values) => void storageAction.send(event, values)}
				/>
			)}
			<Feedback message={storageAction.message} />
		</div>
	);
}
