import { useState, type ReactNode } from "react";
import {
	SettingsSection,
	SettingsNavigation,
	SettingsChanges,
	SettingsDraftBar,
} from "@eumenes/design-system";
import type { ArtifactRequest, ArtifactEvent } from "./contracts";
import type {
	SettingsSectionResource,
	SettingsNavigationResource,
	SettingsChangesResource,
} from "./settings-contracts";
import { useArtifactRuntime } from "./runtime";
import { useSettingsInputs } from "./settings-inputs";

function useSettingsAction(request: ArtifactRequest | string) {
	const runtime = useArtifactRuntime();
	const [message, setMessage] = useState("");
	const source = typeof request === "string" ? request : request.source!;
	function send(
		action: ArtifactEvent["action"],
		values: ArtifactEvent["values"] = {},
	) {
		return runtime
			.dispatch({
				id: crypto.randomUUID(),
				source,
				revision: runtime.snapshot[source]!.revision,
				action,
				values,
			})
			.then((receipt) => {
				setMessage(receipt.status === "accepted" ? "" : receipt.message);
				return receipt;
			})
			.catch(() => {
				const receipt = {
					status: "rejected" as const,
					message: "操作に失敗しました。もう一度お試しください",
				};
				setMessage(receipt.message);
				return receipt;
			});
	}
	return { resource: runtime.snapshot[source], send, message };
}
export function SettingsSectionView({
	request,
	supplement,
	hideFooter,
}: {
	request: ArtifactRequest;
	supplement?: ReactNode;
	hideFooter?: boolean;
}) {
	const action = useSettingsAction(request);
	const resource = action.resource as SettingsSectionResource;
	const inputs = useSettingsInputs(request.source!, resource, (id, value) =>
		action.send("settings-edit", { fieldId: id, value }),
	);
	return (
		<>
			<SettingsSection
				title={request.title ?? "設定"}
				presentation={
					request.view === "settings-section" ? request.presentation : undefined
				}
				description={resource.description}
				fields={inputs.fields}
				groups={resource.groups}
				actions={resource.actions}
				onAction={(id) => action.send("settings-action", { id })}
				dirty={resource.dirty}
				busy={resource.busy}
				blocked={resource.blocked}
				message={resource.message}
				supplement={supplement}
				hideFooter={
					hideFooter ||
					(request.view === "settings-section" && request.footer === false)
				}
				onChange={inputs.change}
				onReview={() => action.send("settings-review")}
				onApply={() => action.send("settings-apply")}
			/>
			<output>{action.message}</output>
		</>
	);
}
export function SettingsDraftBarView({ source }: { source: string }) {
	const action = useSettingsAction(source);
	const resource = action.resource as SettingsSectionResource;
	return (
		<section aria-label="設定の保存" className="aui-settings-save-bar">
			<SettingsDraftBar
				dirty={resource.dirty}
				busy={resource.busy}
				blocked={resource.blocked}
				onApply={() => action.send("settings-apply")}
				onReview={() => action.send("settings-review")}
			/>
			<output aria-live="polite">{action.message || resource.message}</output>
		</section>
	);
}
export function SettingsNavigationView({
	request,
}: {
	request: ArtifactRequest;
}) {
	const action = useSettingsAction(request);
	const resource = action.resource as SettingsNavigationResource;
	return (
		<>
			<SettingsNavigation
				title={request.title ?? "設定"}
				entries={resource.entries}
				dirty={resource.dirty}
				onOpen={(id) => action.send("settings-open", { id })}
			/>
			<output>{action.message}</output>
		</>
	);
}
export function SettingsChangesView({ request }: { request: ArtifactRequest }) {
	const action = useSettingsAction(request);
	const resource = action.resource as SettingsChangesResource;
	return (
		<>
			<SettingsChanges
				title={request.title ?? "設定の変更一覧"}
				rows={resource.rows}
				dirty={resource.dirty}
				busy={resource.busy}
				blocked={resource.blocked}
				message={resource.message}
				onApply={() => action.send("settings-apply")}
				onDiscard={() => action.send("settings-discard")}
			/>
			<output>{action.message}</output>
		</>
	);
}
