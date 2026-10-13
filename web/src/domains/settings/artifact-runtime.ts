import type {
	ArtifactEvent,
	ArtifactRuntime,
	Receipt,
} from "@eumenes/artifact-ui";
import { z } from "zod";
import type { SettingsDraftHost } from "./SettingsDraftHost";
import {
	conversationFields,
	settingsArtifacts,
	type SettingsArtifactId,
} from "./artifact-definition";
import { allVoiceFields } from "./voice-bindings";
import { displayFields } from "./display-bindings";
import type { VoiceTools } from "./voice-presentation";
import {
	defaultSubtitles,
	type Settings,
} from "../../../../api/domains/settings/contracts";

const empty = z.strictObject({});
const edit = z.strictObject({ fieldId: z.string(), value: z.string() });
const open = z.strictObject({
	id: z.enum(["conversation", "voice", "display"]),
});
const accepted = (): Receipt => ({ status: "accepted", message: "" });

function labelValue(field: (typeof conversationFields)[number], value: string) {
	if (!value && field.descriptor.defaultValue)
		return (
			field.descriptor.options?.find(
				(o) => o.value === field.descriptor.defaultValue,
			)?.label ?? "サービスの標準"
		);
	if (field.descriptor.control === "toggle")
		return value === "true" ? "オン" : "オフ";
	if (field.descriptor.control === "multiple")
		return (JSON.parse(value) as string[])
			.map(
				(v) => field.descriptor.options?.find((o) => o.value === v)?.label ?? v,
			)
			.join("、");
	return (
		field.descriptor.options?.find((option) => option.value === value)?.label ??
		value
	);
}
function rows(host: SettingsDraftHost) {
	const saved = host.query.data;
	const value = host.value;
	if (!saved || !value) return [];
	const fields = [
		...conversationFields,
		...displayFields,
		...allVoiceFields(value),
	];
	const changes = fields
		.filter(
			(field) =>
				!field.id.startsWith("speech.cloud.") ||
				saved.resources.some((r) => field.id.includes(r.id)),
		)
		.filter((field) => field.read(saved) !== field.read(value))
		.map((field) => ({
			id: field.id,
			label:
				(conversationFields.includes(field)
					? "会話 / "
					: displayFields.includes(field)
						? "表示 / "
						: "音声と入力 / ") + field.descriptor.label,
			before: labelValue(field, field.read(saved)),
			after: labelValue(field, field.read(value)),
		}));
	const remaining: Settings = structuredClone(value);
	for (const field of fields)
		if (
			!field.id.startsWith("speech.cloud.") ||
			saved.resources.some((r) => field.id.includes(r.id))
		)
			field.restore(remaining, saved);
	if (JSON.stringify(remaining) !== JSON.stringify(saved))
		changes.push({
			id: "legacy",
			label: "既存の設定画面の変更",
			before: "保存済みの設定",
			after: "未適用の変更あり（既存画面で確認）",
		});
	if (host.keys.length)
		changes.push({
			id: "credentials",
			label: "認証情報",
			before: "現在の認証情報",
			after: "更新・削除予定 " + host.keys.length + "件",
		});
	if (host.adding)
		changes.push({
			id: "registration",
			label: "接続の登録",
			before: "未登録",
			after: "既存の設定画面で登録内容を確定してください",
		});
	return changes;
}

/** Authorized UI events only; physical storage and secrets never enter snapshot. */
export function settingsArtifactRuntime(
	host: SettingsDraftHost,
	onOpen: (id: SettingsArtifactId) => void,
	voice?: VoiceTools,
): ArtifactRuntime {
	const revision = host.revision;
	return {
		snapshot: {
			"settings-hub": {
				kind: "settings-navigation",
				revision,
				dirty: host.dirty,
				entries: [
					{
						id: "conversation",
						label: "会話",
						description: "AIの名前 あなたの名前 口調",
						group: "使い方を変える",
						enabled: true,
					},
					{
						id: "voice",
						label: "音声と入力",
						description: "読み上げ 聞き取り 機器",
						group: "使い方を変える",
						enabled: true,
					},
					{
						id: "display",
						label: "表示",
						description: "背景 テーマ 字幕",
						group: "使い方を変える",
						enabled: true,
					},
					...["AIと接続", "外部作業"].map((label) => ({
						id: label,
						label,
						group: "使い方を変える",
						enabled: false,
					})),
					...["記憶", "読み方辞書", "動作確認", "記録"].map((label) => ({
						id: label,
						label,
						group: "管理と確認",
						enabled: false,
					})),
				],
			},
			"settings-conversation": {
				kind: "settings-section",
				revision,
				dirty: host.dirty,
				busy: host.busy,
				blocked: host.adding,
				message: host.message,
				description:
					"名前と口調を設定します。変更は適用後、次の返答から反映されます。",
				fields: host.value
					? conversationFields.map((field) => ({
							...field.descriptor,
							id: field.id,
							value: field.read(host.value!),
						}))
					: [],
			},
			"settings-voice-input": {
				kind: "settings-section",
				revision,
				dirty: host.dirty,
				busy: host.busy,
				blocked: host.adding,
				message: host.message,
				description: "声と音声入力を設定します。",
				fields: voice?.fields ?? [],
				groups: voice?.groups,
				actions: voice?.actions,
			},
			"settings-display": {
				kind: "settings-section",
				revision,
				dirty: host.dirty,
				busy: host.busy,
				blocked: host.adding,
				message: host.message,
				description:
					"会話の背景、テーマ、読み上げ字幕を設定します。背景とテーマは保存後に反映します。字幕の見本は編集中の値を表示します。",
				fields: host.value
					? displayFields.map((field) => ({
							...field.descriptor,
							id: field.id,
							value: field.read(host.value!),
						}))
					: [],
			},
			"settings-display-preview": {
				kind: "subtitle-preview",
				revision,
				text: "これは字幕のプレビューです。",
				...(host.value?.general.subtitles ?? defaultSubtitles),
			},
			"settings-changes": {
				kind: "settings-changes",
				revision,
				dirty: host.dirty,
				busy: host.busy,
				blocked: host.adding,
				message: host.message,
				rows: rows(host),
			},
		},
		dispatch: async (event: ArtifactEvent) => {
			const known = Object.values(settingsArtifacts).find(
				(artifact) => artifact.source === event.source,
			);
			if (!known || !host.current().value)
				return { status: "rejected", message: "この設定は操作できません" };
			if (host.receipts.current.has(event.id))
				return { status: "duplicate", message: "この操作は受付済みです" };
			if (event.revision !== host.current().revision)
				return {
					status: "conflict",
					message:
						"設定の表示が更新されています。最新の表示から操作してください",
				};
			try {
				if (
					event.action === "settings-edit" &&
					(known === settingsArtifacts.conversation ||
						known === settingsArtifacts.display)
				) {
					const input = edit.parse(event.values);
					const field = (
						known === settingsArtifacts.display
							? displayFields
							: conversationFields
					).find((field) => field.id === input.fieldId);
					if (!field)
						return { status: "rejected", message: "未登録の設定項目です" };
					host.change((settings) => field.edit(settings, input.value));
				} else if (
					known === settingsArtifacts.voice &&
					voice &&
					event.action === "settings-edit"
				) {
					const input = edit.parse(event.values);
					if (!voice.edit(input.fieldId, input.value))
						return {
							status: "rejected",
							message: "この設定項目は操作できません",
						};
				} else if (
					known === settingsArtifacts.voice &&
					voice &&
					event.action === "settings-action"
				) {
					const input = z.strictObject({ id: z.string() }).parse(event.values);
					voice.action(input.id);
				} else if (
					event.action === "settings-open" &&
					known === settingsArtifacts.hub
				) {
					onOpen(open.parse(event.values).id);
				} else if (
					event.action === "settings-review" &&
					known !== settingsArtifacts.changes
				) {
					empty.parse(event.values);
					onOpen("changes");
				} else if (
					event.action === "settings-apply" &&
					(known === settingsArtifacts.changes ||
						known === settingsArtifacts.conversation ||
						known === settingsArtifacts.display ||
						known === settingsArtifacts.voice)
				) {
					empty.parse(event.values);
					if (host.busy || host.adding || !host.dirty)
						return {
							status: "rejected",
							message: "変更を適用できる状態ではありません",
						};
					remember(host, event.id);
					return (await host.apply())
						? accepted()
						: {
								status: "rejected",
								message:
									"変更を適用できませんでした。表示された内容を確認してください",
							};
				} else if (
					event.action === "settings-discard" &&
					known === settingsArtifacts.changes
				) {
					empty.parse(event.values);
					if (host.busy) return { status: "rejected", message: "適用中です" };
					host.discard();
				} else
					return {
						status: "rejected",
						message: "この表示では使えない操作です",
					};
				remember(host, event.id);
				return accepted();
			} catch {
				return {
					status: "rejected",
					message: "入力の型、文字数、選択肢を確認してください",
				};
			}
		},
	};
}
function remember(host: SettingsDraftHost, id: string) {
	host.receipts.current.add(id);
	if (host.receipts.current.size > 128)
		host.receipts.current.delete(host.receipts.current.values().next().value!);
}
