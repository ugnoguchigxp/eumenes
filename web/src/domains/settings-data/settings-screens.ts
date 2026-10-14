import type {
	SettingsFieldGroup,
	SettingsInputField,
	SettingsPanelAction,
} from "@eumenes/design-system";
import type { Snapshot } from "@eumenes/artifact-ui";
import type { ActionBindingV1 } from "../../../../api/domains/capabilities/contracts";
import {
	defaultSubtitles,
	type Settings,
} from "../../../../api/domains/settings/contracts";
import type { ToolchainArtifactEntry } from "../../../../client/toolchain-actions";
import { serviceSummary } from "../settings/voice-presentation";
import {
	reviewRows,
	toWire,
	type DocumentAccess,
	type FieldRule,
	type RegisteredField,
} from "../toolchain-artifacts/documents";
import {
	entryKey,
	type DraftEntry,
	type DraftView,
} from "../toolchain-artifacts/drafts";
import { artifactIdOf, entryLabel } from "../toolchain-artifacts/launcher";
import { navigationTargets } from "../toolchain-artifacts/navigation";
import { readPath, writePath } from "./paths";
import type { VoiceTools } from "./useVoiceTools";

/** Wording for the codes the settings adapter refuses an apply with. */
export const settingsMessages: Record<string, string> = {
	invalid_settings:
		"設定の内容がこのアプリの条件に合いません。入力を確認してください。",
	field_not_registered: "登録されていない設定項目が含まれています。",
	unset_not_allowed: "この項目は空にできません。値を入力してください。",
	target_not_found:
		"対象のモデルや接続が見つかりません。画面を更新してやり直してください。",
	invalid_value: "入力値がこの項目の条件に合いません。",
	secret_key_unavailable:
		"認証情報を保存できませんでした。保存用の鍵の状態を確認してください。",
};

const groupInfo = (s: Settings): Record<string, SettingsFieldGroup> => ({
	speech: {
		id: "speech",
		label: "読み上げ",
		description: "",
	},
	input: {
		id: "input",
		label: "聞き取り",
		description:
			serviceSummary(s, "asr") +
			"\n録音の調整は適用後、次の音声開始から反映します。",
	},
	devices: { id: "devices", label: "機器", description: "" },
});

/** The panel actions of the voice screen, performed locally (the browser or the voice API). */
const panelActions: Record<string, { label: string; group: string }> = {
	"voice-refresh": { label: "声の一覧を再取得", group: "speech" },
	"voice-sample": { label: "サンプルを再生", group: "speech" },
	"devices-discover": { label: "音声機器を確認", group: "devices" },
};

export function sectionDescription(fields: readonly RegisteredField[]) {
	const first = fields[0]?.path ?? "";
	if (
		first.startsWith("$.general.agentName") ||
		first.startsWith("$.general.userName") ||
		first.startsWith("$.general.persona")
	)
		return "名前と口調を設定します。変更は適用後、次の返答から反映されます。";
	if (fields.some((f) => f.path === "$.general.theme"))
		return "会話の背景、テーマ、読み上げ字幕を設定します。背景とテーマは保存後に反映します。字幕の見本は編集中の値を表示します。";
	return "声と音声入力を設定します。";
}

/** The saved document with the shared draft applied: what the screen should show. */
export function applyDraft(
	saved: Settings,
	entries: ReadonlyArray<DraftEntry>,
	fields: ReadonlyArray<RegisteredField>,
): Settings {
	if (entries.length === 0) return saved;
	const next = structuredClone(saved);
	const byId = new Map(fields.map((f) => [f.fieldId, f] as const));
	for (const entry of entries) {
		const field = byId.get(entry.fieldId);
		if (field) writePath(next, field.path, entry.target, entry.change);
	}
	return next;
}

/** Registered fields -> input descriptors (a field with a target appears once per target). */
export function buildInputs({
	effective,
	own,
	access,
	ruleOf,
	voice,
	speechActive,
}: {
	effective: Settings | undefined;
	own: ReadonlyArray<RegisteredField>;
	access: DocumentAccess;
	ruleOf: (field: RegisteredField, target?: string) => FieldRule | null;
	voice: VoiceTools;
	speechActive: boolean;
}) {
	const inputs: SettingsInputField[] = [];
	if (effective) {
		for (const field of own) {
			const list = field.target
				? access.targets(field)
				: [{ id: undefined, label: "" }];
			for (const target of list) {
				const rule = ruleOf(field as RegisteredField, target.id);
				if (!rule) continue;
				inputs.push({
					id: entryKey(field.fieldId, target.id),
					label: target.id ? `${target.label} の${field.label}` : field.label,
					...(field.help ? { help: field.help } : {}),
					control: field.control,
					value: toWire(readPath(effective, field.path, target.id)),
					...(rule.defaultValue !== undefined
						? { defaultValue: rule.defaultValue }
						: {}),
					...(rule.maxLength ? { maxLength: rule.maxLength } : {}),
					...(rule.min !== undefined ? { minimum: rule.min } : {}),
					...(rule.max !== undefined ? { maximum: rule.max } : {}),
					...(rule.step ? { step: rule.step } : {}),
					...(rule.options ? { options: [...rule.options] } : {}),
					...(field.group ? { group: field.group } : {}),
					...(field.detail ? { detail: true } : {}),
					...(rule.disabled ? { disabled: true } : {}),
					...(field.searchable ? { searchable: true } : {}),
				});
			}
		}
		if (speechActive && voice.targets.length > 1) {
			const at = inputs.findIndex(
				(i) =>
					i.id.includes("~") ||
					own
						.find((f) => f.fieldId === i.id.split("~")[0])
						?.path.startsWith("$.larm."),
			);
			const selector: SettingsInputField = {
				id: "speech.target",
				label: "調整する読み上げ先",
				control: "select",
				group: "speech",
				value: voice.target,
				options: voice.targets,
				help: "ここでは声だけを調整します。利用先の割当は変わりません。",
			};
			inputs.splice(at < 0 ? inputs.length : at, 0, selector);
		}
	}
	return inputs;
}

/** The voice panel's actions, enabled by one registered `settings-action` local binding. */
export function buildActions({
	effective,
	saved,
	speechActive,
	bindings,
	voice,
}: {
	effective: Settings | undefined;
	saved: Settings | undefined;
	speechActive: boolean;
	bindings: ReadonlyArray<ActionBindingV1>;
	voice: VoiceTools;
}) {
	const panelSources = new Set(
		bindings
			.filter(
				(b) => b.eventAction === "settings-action" && b.effect === "local",
			)
			.map((b) => b.source),
	);
	const actions: SettingsPanelAction[] = [];
	if (effective && saved && speechActive && panelSources.size > 0)
		for (const [id, base] of Object.entries(panelActions)) {
			if (id !== "devices-discover" && voice.target !== "local") continue;
			const disabled =
				id === "voice-refresh"
					? voice.connectionChanged ||
						!saved.larm.baseUrl ||
						voice.voices.isFetching
					: id === "voice-sample"
						? voice.connectionChanged || !voice.canSample
						: voice.checking;
			actions.push({
				id,
				group: base.group,
				disabled,
				label:
					id === "voice-sample"
						? voice.sample.state === "loading"
							? "サンプルの準備を取消"
							: voice.sample.state === "playing"
								? "サンプルを停止"
								: base.label
						: id === "devices-discover" && voice.checking
							? "音声機器を確認中…"
							: base.label,
			});
		}
	return actions;
}

/** The resource of every source the registered bindings give a kind to. */
export function buildSnapshot({
	effective,
	artifact,
	own,
	all,
	access,
	view,
	revision,
	dirty,
	inputs,
	groups,
	actions,
	catalog,
	documentFieldsReady,
}: {
	effective: Settings | undefined;
	artifact: {
		actionBindings: ReadonlyArray<ActionBindingV1>;
		sourceBindings: ReadonlyArray<{ source: string }>;
	};
	own: ReadonlyArray<RegisteredField>;
	all: ReadonlyArray<RegisteredField>;
	access: DocumentAccess;
	view: DraftView;
	revision: number;
	dirty: boolean;
	inputs: SettingsInputField[];
	groups: SettingsFieldGroup[];
	actions: SettingsPanelAction[];
	catalog: ReadonlyArray<ToolchainArtifactEntry>;
	documentFieldsReady: boolean;
}) {
	// Which source each resource kind belongs to follows from the registered bindings.
	const bindings = artifact.actionBindings;
	const sectionSources = new Set(
		bindings
			.filter((b) => b.effect === "draft" && b.draftAction === "edit")
			.map((b) => b.source),
	);
	const changesSources = new Set(
		bindings
			.filter((b) => b.effect === "draft" && b.draftAction === "discard")
			.map((b) => b.source),
	);
	const hubBindings = bindings.filter(
		(b) => b.effect === "navigate" && b.eventAction === "settings-open",
	);
	const hubSources = new Set(hubBindings.map((b) => b.source));
	const snapshot: Record<string, Snapshot[string]> = {};
	if (effective) {
		for (const source of sectionSources)
			snapshot[source] = {
				kind: "settings-section",
				revision,
				dirty,
				busy: view.busy,
				blocked: false,
				message: view.message,
				description: sectionDescription(own as RegisteredField[]),
				fields: inputs,
				...(inputs.some((i) => i.group) ? { groups } : {}),
				...(actions.length ? { actions } : {}),
			};
		for (const source of changesSources)
			snapshot[source] = {
				kind: "settings-changes",
				revision,
				dirty,
				busy: view.busy,
				blocked: false,
				message: view.message,
				rows: reviewRows(view, all, access, documentFieldsReady),
			};
		for (const source of hubSources)
			snapshot[source] = {
				kind: "settings-navigation",
				revision,
				dirty,
				entries: hubBindings
					.filter((b) => b.source === source)
					.flatMap((b) => navigationTargets(b))
					.map((target) => {
						const entry = catalog.find(
							(e) => artifactIdOf(e.artifactRevisionId) === target.artifactId,
						);
						return {
							id: target.id,
							label: entry ? entryLabel(entry) : target.id,
							...(entry?.launcher?.description
								? { description: entry.launcher.description }
								: {}),
							group: entry?.launcher?.group ?? "管理と確認",
							enabled: !!entry,
						};
					}),
			};
		for (const binding of artifact.sourceBindings)
			if (binding.source.endsWith("-preview"))
				snapshot[binding.source] = {
					kind: "subtitle-preview",
					revision,
					text: "これは字幕のプレビューです。",
					...(effective.general.subtitles ?? defaultSubtitles),
				};
	}
	return snapshot;
}

/** Group headers with the live status text of the voice screen. */
export function groupsFor(
	inputs: SettingsInputField[],
	effective: Settings | undefined,
	voice: VoiceTools,
	saved: Settings | undefined,
): SettingsFieldGroup[] {
	if (!effective) return [];
	const info = groupInfo(effective);
	const status =
		voice.target !== "local"
			? "声の一覧・スタイル・抑揚の取得にはこのAPIが対応していません。音声IDと速度を指定します。クラウドの生成確認は保存後に既存の「サービスを試す」で行います。"
			: voice.connectionChanged
				? "接続先の変更を適用してから声の一覧を取得してください。"
				: voice.voices.isFetching
					? "声の一覧を取得しています。"
					: voice.voices.isError
						? "声の一覧を取得できません。接続を確認して再取得してください。" +
							(effective.larm.voice ? " 保存した声の試聴はできます。" : "")
						: !voice.catalog
							? "LARMの接続先を設定してから声の一覧を取得してください。"
							: "サービスが対応する調整項目だけを表示しています。";
	info.speech!.description =
		serviceSummary(effective, "tts") +
		"\n変更は適用後、次の発話から反映します。\n" +
		status +
		(voice.selected?.credit ? "\nクレジット：" + voice.selected.credit : "") +
		(voice.sample.error ? "\n" + voice.sample.error : "");
	info.devices!.description =
		"機器確認ボタンを押すとマイクの許可を求めます。変更は適用後、次の音声開始から反映します。" +
		(voice.outputSupported
			? ""
			: "\nこのブラウザは再生先の切替に対応していません。システム標準を使います。") +
		(voice.deviceMessage ? "\n" + voice.deviceMessage : "");
	void saved;
	const order: string[] = [];
	for (const input of inputs)
		if (input.group && !order.includes(input.group)) order.push(input.group);
	return order.map((id) => info[id] ?? { id, label: id });
}
