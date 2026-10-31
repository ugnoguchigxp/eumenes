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
import { serviceSummary } from "./voice-presentation";
import {
	reviewRows,
	toWire,
	type DocumentAccess,
	type FieldRule,
	type RegisteredField,
} from "../toolchain-artifacts/documents";
import {
	DELETE_SUFFIX,
	SECRET_MASK,
	entryKey,
	type DraftEntry,
	type DraftView,
} from "../toolchain-artifacts/drafts";
import { artifactIdOf, entryLabel } from "../toolchain-artifacts/launcher";
import { navigationTargets } from "../toolchain-artifacts/navigation";
import { readPath, writePath } from "../toolchain-artifacts/paths";
import { isSpeechTarget } from "./settings-rules";
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
	credential_required:
		"認証情報が必要です。APIキー認証ではAPIキーか環境変数名、サブスクリプションでは setup-token のトークンを入力してください。",
	auth_required: "Claude Agent SDKの接続には認証方式の指定が必要です。",
	invalid_billing_path_change:
		"使用中のモデルがある接続の認証方式は変更できません。新しい接続を登録して、モデルを選び直してください。",
	invalid_credential_source:
		"APIキーと環境変数名は同時に使えません。どちらか一方にしてください。",
	connection_exists: "同じ接続がすでに登録されています。",
	resource_exists: "同じモデルがすでに登録されています。",
	invalid_larm_origin_unconfirmed:
		"LARM の接続先の変更が確認されませんでした。",
	invalid_env_ref: "この環境変数は認証情報として指定できません。",
	invalid_env_ref_host_conflict:
		"この環境変数は、同じ接続先ホストの別の接続で使われています。",
	invalid_origin_requires_new_key:
		"接続先のオリジンを変えるときは、新しいAPIキーを入力してください。",
	invalid_key_connection: "APIキーを保存する接続が見つかりません。",
	invalid_duplicate_key: "同じ接続のAPIキーが重複して指定されています。",
	secret_key_unavailable:
		"認証情報を保存できませんでした。保存用の鍵の状態を確認してください。",
};

const groupInfo = (s: Settings): Record<string, SettingsFieldGroup> => ({
	appearance: { id: "appearance", label: "背景とテーマ" },
	subtitles: { id: "subtitles", label: "字幕" },
	particles: { id: "particles", label: "粒子" },
	motion: { id: "motion", label: "動き" },
	state: {
		id: "state",
		label: "状態プレビュー",
		description:
			"実測取得経路は未接続です。デモ値は実際の状態や導入済みProviderを表しません。",
	},
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
	notifications: {
		id: "notifications",
		label: "通知音",
		description:
			"生成やタスクの完了などを知らせる音です。保存前でも試聴できます。読み上げと共通の音量・再生機器を使います。",
	},
	devices: { id: "devices", label: "機器", description: "" },
	larm: { id: "larm", label: "LARM接続" },
	"route-llm": { id: "route-llm", label: "会話の利用先" },
	"route-asr": { id: "route-asr", label: "聞き取りの利用先" },
	"route-tts": { id: "route-tts", label: "読み上げの利用先" },
});

/** The panel actions of the voice screen, performed locally (the browser or the voice API). */
const panelActions: Record<string, { label: string; group: string }> = {
	"completion-sample": { label: "完了音声を試聴", group: "notifications" },
	"notification-sample": { label: "通知音を試聴", group: "notifications" },
	"voice-refresh": { label: "声の一覧を再取得", group: "speech" },
	"voice-sample": { label: "サンプルを再生", group: "speech" },
	"devices-discover": { label: "音声機器を確認", group: "devices" },
};

function sectionDescription(fields: readonly RegisteredField[]) {
	if (fields.some((f) => f.path.startsWith("$.live.")))
		return "音声会話中は既存のASR・TTSを使わず、双方の文字起こしをチャットに残します。音声ファイルは保存しません。接続・試用にはAPIの利用料金が発生します。";
	const first = fields[0]?.path ?? "";
	if (
		first.startsWith("$.general.agentName") ||
		first.startsWith("$.general.userName") ||
		first.startsWith("$.general.persona")
	)
		return "名前と口調を設定します。変更は適用後、次の返答から反映されます。";
	if (fields.some((f) => f.path.startsWith("$.general.spatial")))
		return "背景・字幕・Spatialの粒子と動きをタブで調整します。変更は保存後に会話の背景へ反映します。状態プレビューは実測値ではありません。";
	if (fields.some((f) => f.path === "$.general.theme"))
		return "会話の背景、テーマ、読み上げ字幕を設定します。背景とテーマは保存後に反映します。字幕の見本は編集中の値を表示します。";
	if (
		fields.some(
			(f) =>
				f.path.startsWith("$.larm.baseUrl") ||
				f.path.startsWith("$.routes") ||
				f.path.startsWith("$.connections"),
		)
	)
		return "LARM、AIの利用先、クラウド接続とモデルを設定します。変更は適用後に反映されます。";
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
	view,
}: {
	effective: Settings | undefined;
	view: DraftView;
	own: ReadonlyArray<RegisteredField>;
	access: DocumentAccess;
	ruleOf: (field: RegisteredField, target?: string) => FieldRule | null;
	voice: VoiceTools;
	speechActive: boolean;
}) {
	const inputs: SettingsInputField[] = [];
	// Each target of a per-target field (a connection, a model) is its own group.
	const targetGroups = new Map<string, string>();
	if (effective) {
		for (const field of own) {
			const list = field.target
				? access.targets(field)
				: [{ id: undefined, label: "" }];
			for (const target of list) {
				const rule = ruleOf(field as RegisteredField, target.id);
				if (!rule) continue;
				const grouped = !!target.id && !isSpeechTarget(field);
				const group = grouped
					? `${field.group ?? "target"}~${target.id}`
					: field.group;
				if (grouped && group) targetGroups.set(group, target.label);
				inputs.push({
					id: entryKey(field.fieldId, target.id),
					label:
						target.id && !grouped
							? `${target.label} の${field.label}`
							: field.label,
					...(field.help ? { help: field.help } : {}),
					control: field.control,
					...(field.presentation ? { presentation: field.presentation } : {}),
					value: field.confidential
						? SECRET_MASK.repeat(
								view.secrets.find(
									(x) => x.fieldId === field.fieldId && x.target === target.id,
								)?.length ?? 0,
							)
						: toWire(readPath(effective, field.path, target.id)),
					...(rule.defaultValue !== undefined
						? { defaultValue: rule.defaultValue }
						: {}),
					...(rule.maxLength ? { maxLength: rule.maxLength } : {}),
					...(rule.min !== undefined ? { minimum: rule.min } : {}),
					...(rule.max !== undefined ? { maximum: rule.max } : {}),
					...(rule.step ? { step: rule.step } : {}),
					...(rule.options ? { options: [...rule.options] } : {}),
					...(group ? { group } : {}),
					...(field.detail ? { detail: true } : {}),
					...(rule.disabled ? { disabled: true } : {}),
					...(field.searchable ? { searchable: true } : {}),
				});
				// A secret that may be unset also gets a switch to delete the stored one.
				if (field.confidential && field.unset)
					inputs.push({
						id: `${entryKey(field.fieldId, target.id)}${DELETE_SUFFIX}`,
						label: "キーを削除",
						help: "保存済みのキーを削除します。環境変数を使う場合などに使います。",
						control: "toggle",
						value: view.secrets.some(
							(x) =>
								x.fieldId === field.fieldId &&
								x.target === target.id &&
								x.delete,
						)
							? "true"
							: "false",
						...(group ? { group } : {}),
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
	return { inputs, targetGroups };
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
			if (base.group === "speech" && voice.target !== "local") continue;
			const disabled =
				id === "completion-sample"
					? !voice.completion.available ||
						(effective.voice.outputVolume <= 0 && !voice.completion.playing)
					: id === "notification-sample"
						? !voice.notification.available ||
							(effective.voice.outputVolume <= 0 && !voice.notification.playing)
						: id === "voice-refresh"
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
					id === "completion-sample"
						? voice.completion.playing
							? "完了音声の試聴を停止"
							: base.label
						: id === "notification-sample"
							? voice.notification.playing
								? "通知音の試聴を停止"
								: base.label
							: id === "voice-sample"
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
							...(entry?.launcher?.icon ? { icon: entry.launcher.icon } : {}),
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
	targetGroups: ReadonlyMap<string, string> = new Map(),
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
	if (!voice.notification.available)
		info.notifications!.description +=
			"\n以前に選んだ通知音は再制作待ちです。試聴確認済みの音を選び、保存してください。";
	if (voice.completion.error)
		info.notifications!.description += "\n" + voice.completion.error;
	if (voice.notification.error)
		info.notifications!.description += "\n" + voice.notification.error;
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
	return order.map(
		(id) => info[id] ?? { id, label: targetGroups.get(id) ?? id },
	);
}
