import type {
	SettingsInputField,
	SettingsFieldGroup,
	SettingsPanelAction,
} from "@eumenes/design-system";
import type { EumenesClient } from "../../../../client";
import type { Settings } from "../../../../api/domains/settings/contracts";
import {
	voiceFields,
	localVoiceFields,
	cloudVoiceFields,
	inputField,
} from "./voice-bindings";
import { presentationLabel } from "./shared";
export type VoiceCatalog = Awaited<ReturnType<EumenesClient["larmVoices"]>>;
export type VoiceTools = {
	fields: SettingsInputField[];
	groups: SettingsFieldGroup[];
	actions: SettingsPanelAction[];
	edit: (id: string, value: string) => boolean;
	action: (id: string) => void;
};
export function speechTargets(s: Settings) {
	return [
		...(s.routes.tts.mode !== "cloud-only"
			? [{ value: "local", label: "ローカルの声" }]
			: []),
		...s.resources
			.filter((r) => r.purpose === "tts")
			.map((r) => ({
				value: r.id,
				label:
					(s.connections.find((c) => c.id === r.connectionId)?.name ??
						"登録モデル") +
					" / " +
					r.model +
					(s.routes.tts.fallbackId === r.id ? "（割当済み）" : "（未割当）"),
			})),
	];
}
export function serviceSummary(s: Settings, purpose: "tts" | "asr") {
	const route = s.routes[purpose];
	const r = s.resources.find((r) => r.id === route.fallbackId);
	const cloud = r
		? (s.connections.find((c) => c.id === r.connectionId)?.name ??
				"登録モデル") +
			" / " +
			r.model
		: "未割当";
	return (
		(route.mode === "cloud-only"
			? "クラウドのみ：" + cloud
			: route.mode === "larm-only"
				? "ローカルのみ"
				: !route.cloudAllowed
					? "ローカル優先。クラウドへの送信は許可していません"
					: "ローカル優先。切り替わったとき：" + cloud) +
		"。利用先・送信許可は既存設定の「AIの使い方」で変更します。"
	);
}
function selectedOptions(
	options: { value: string; label: string }[],
	value: string,
	missing: string,
) {
	return value && !options.some((o) => o.value === value)
		? [...options, { value, label: missing }]
		: options;
}
function localInputs(
	s: Settings,
	catalog?: VoiceCatalog,
): SettingsInputField[] {
	const selected = catalog?.voices.find(
		(v) => v.id === (s.larm.voice || catalog.default_voice),
	);
	const character = inputField(localVoiceFields[0]!, s);
	character.options = selectedOptions(
		[
			{ value: "", label: "サービスの既定のキャラクター" },
			...(catalog?.voices.map((v) => ({
				value: v.id,
				label:
					v.display_name +
					(presentationLabel[v.voice_presentation ?? ""] ?? ""),
			})) ?? []),
		],
		s.larm.voice,
		"保存されたキャラクター（一覧で確認できません）",
	);
	character.disabled = !catalog;
	const fields = [character];
	if (!selected) return fields;
	for (const field of localVoiceFields.slice(1)) {
		const input = inputField(field, s);
		if (field.id.endsWith(".style")) {
			if (!selected.styles.length) continue;
			input.options = selectedOptions(
				[
					{ value: "", label: "サービスの標準" },
					...selected.styles.map((v) => ({
						value: v.id,
						label: v.display_name,
					})),
				],
				s.larm.style ?? "",
				"保存されたスタイル（一覧で確認できません）",
			);
		} else if (
			field.id.endsWith(".autoIntonation") ||
			field.id.endsWith(".autoStrength")
		) {
			if (
				!selected.capabilities.intonation_scale ||
				(field.id.endsWith(".autoStrength") && !s.larm.autoIntonation)
			)
				continue;
		} else {
			const key = field.id.split(".").at(-1)!;
			const range =
				selected.capabilities[
					key === "pitchScale"
						? "pitch_scale"
						: key === "intonationScale"
							? "intonation_scale"
							: "speed"
				];
			if (!range) continue;
			input.minimum = range.minimum;
			input.maximum = range.maximum;
			input.defaultValue = String(range.default);
		}
		fields.push(input);
	}
	return fields;
}
export function voiceInputFields(
	s: Settings,
	target: string,
	catalog: VoiceCatalog | undefined,
	devices: MediaDeviceInfo[],
	outputSupported: boolean,
) {
	const fields = voiceFields
		.filter((f) => f.id !== "output.device" || outputSupported)
		.map((f) => inputField(f, s));
	for (const field of fields.filter(
		(f) => f.id === "input.device" || f.id === "output.device",
	)) {
		const kind = field.id === "input.device" ? "audioinput" : "audiooutput";
		const options = [
			{ value: "", label: "システム標準" },
			...devices
				.filter((d) => d.kind === kind && d.deviceId)
				.map((d) => ({ value: d.deviceId, label: d.label || field.label })),
		];
		field.options = selectedOptions(
			options.filter(
				(o, i, all) => all.findIndex((v) => v.value === o.value) === i,
			),
			field.value,
			"選択した機器を確認できません",
		);
	}
	const targets = speechTargets(s);
	if (targets.length > 1)
		fields.push({
			id: "speech.target",
			label: "調整する読み上げ先",
			control: "select",
			group: "speech",
			value: target,
			options: targets,
			help: "ここでは声だけを調整します。利用先の割当は変わりません。",
		});
	fields.push(
		...(target === "local"
			? localInputs(s, catalog)
			: cloudVoiceFields(s)
					.filter((f) => f.id.startsWith("speech.cloud." + target + "."))
					.map((f) => inputField(f, s))),
	);
	return fields;
}
