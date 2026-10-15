import type { Settings } from "../../../../api/domains/settings/contracts";
import { presentationLabel } from "../settings/shared";
import type {
	DocumentAccess,
	FieldRule,
	RegisteredField,
} from "../toolchain-artifacts/documents";
import type { FieldChange } from "../toolchain-artifacts/drafts";
import { settingsConditions } from "./conditions";
import { readPath } from "../toolchain-artifacts/paths";
import type { VoiceTools } from "./useVoiceTools";

/**
 * A speech field of one cloud TTS model (`$.resources[id=$target].voice` or `.speed`): only the
 * speech target being adjusted shows its fields. Other per-target fields show every target.
 */
export function isSpeechTarget(field: { path: string; target?: string }) {
	return (
		!!field.target &&
		(field.path === "$.resources[id=$target].voice" ||
			field.path === "$.resources[id=$target].speed")
	);
}

/** The registered fixed choices (the "default" entry), or a stand-in when none are registered. */
function placeholder(
	field: { options?: ReadonlyArray<{ value: string; label: string }> },
	label: string,
) {
	return field.options?.length ? field.options : [{ value: "", label }];
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

/** The limits in force for a field right now, from the effective document and the catalogs. */
export function createRuleOf({
	effective,
	voice,
	fetchedOptions,
}: {
	effective: Settings | undefined;
	voice: VoiceTools;
	fetchedOptions: ReadonlyMap<string, { value: string; label: string }[]>;
}) {
	const ruleOf = (
		field: RegisteredField,
		target?: string,
	): FieldRule | null => {
		if (!effective) return null;
		if (isSpeechTarget(field) && voice.target !== target) return null;
		const resource = effective.resources.find((r) => r.id === target);
		const workers =
			effective.connections.find((c) => c.id === resource?.connectionId)
				?.kind === "cloudflare-workers-ai";
		if (field.path === "$.resources[id=$target].speed" && workers) return null;
		if (field.path === "$.resources[id=$target].language" && !workers)
			return null;
		if (
			field.visibleWhen &&
			!settingsConditions[field.visibleWhen]?.({ effective, voice, target })
		)
			return null;
		const rule: FieldRule = {
			options: field.optionsSource
				? fetchedOptions.get(field.optionsSource)
				: field.options,
			min: field.min,
			max: field.max,
			step: field.step,
			maxLength: field.maxLength,
			defaultValue: field.defaultValue,
		};
		const value = String(readPath(effective, field.path, target) ?? "");
		switch (field.path) {
			case "$.larm.voice": {
				rule.options = selectedOptions(
					[
						...placeholder(field, "サービスの既定のキャラクター"),
						...(voice.catalog?.voices.map((v) => ({
							value: v.id,
							label:
								v.display_name +
								(presentationLabel[v.voice_presentation ?? ""] ?? ""),
						})) ?? []),
					],
					value,
					"保存されたキャラクター（一覧で確認できません）",
				);
				rule.disabled = !voice.catalog;
				break;
			}
			case "$.larm.style":
				rule.options = selectedOptions(
					[
						...placeholder(field, "サービスの標準"),
						...(voice.selected?.styles.map((v) => ({
							value: v.id,
							label: v.display_name,
						})) ?? []),
					],
					value,
					"保存されたスタイル（一覧で確認できません）",
				);
				break;
			case "$.larm.speed":
			case "$.larm.pitchScale":
			case "$.larm.intonationScale": {
				const range =
					voice.selected?.capabilities[
						field.path === "$.larm.pitchScale"
							? "pitch_scale"
							: field.path === "$.larm.intonationScale"
								? "intonation_scale"
								: "speed"
					];
				if (range) {
					rule.min = range.minimum;
					rule.max = range.maximum;
					rule.defaultValue = String(range.default);
				}
				break;
			}
			case "$.voice.inputDevice":
			case "$.voice.outputDevice": {
				const kind =
					field.path === "$.voice.inputDevice" ? "audioinput" : "audiooutput";
				const listed = [
					...placeholder(field, "システム標準"),
					...voice.devices
						.filter((d) => d.kind === kind && d.deviceId)
						.map((d) => ({ value: d.deviceId, label: d.label || field.label })),
				].filter(
					(o, i, list) => list.findIndex((v) => v.value === o.value) === i,
				);
				rule.options = selectedOptions(
					listed,
					value,
					"選択した機器を確認できません",
				);
				break;
			}
		}
		return rule;
	};
	return ruleOf;
}

/** The saved copy of the settings document and the rules the host checks draft edits with. */
export function createAccess({
	saved,
	effective,
	voice,
	targetsOf,
	ruleOf,
}: {
	saved: Settings | undefined;
	effective: Settings | undefined;
	voice: VoiceTools;
	targetsOf: (
		field: RegisteredField,
	) => ReadonlyArray<{ id: string; label: string }>;
	ruleOf: (field: RegisteredField, target?: string) => FieldRule | null;
}): DocumentAccess {
	const access: DocumentAccess = {
		ready: !!saved,
		revision: saved?.revision ?? 0,
		read: (field, target) =>
			saved ? readPath(saved, field.path, target) : undefined,
		rule: (field, target) => ruleOf(field as RegisteredField, target),
		targets: (field) => targetsOf(field as RegisteredField),
		confirmations(dirty) {
			// Credentials go to the new origin: the user confirms it, as the legacy page did.
			const origin = (url: string | null | undefined) =>
				url && URL.canParse(url) ? new URL(url).origin : null;
			const changed = dirty.some((d) => d.field?.path === "$.larm.baseUrl");
			const before = origin(saved?.larm.baseUrl);
			const after = origin(effective?.larm.baseUrl);
			return changed && before && after && before !== after
				? [
						{
							structure: "structure:settings.confirm-larm-origin@1",
							input: { origin: after },
							prompt: `LARM の接続先を ${after} に変更します。LARM の認証情報はこの接続先へ送られます。変更しますか？`,
							declined:
								"LARMの接続先の変更を確認しなかったため適用していません。",
						},
					]
				: [];
		},
		derive(field, _target, change) {
			if (field.path !== "$.larm.voice" || "unset" in change) return [];
			const id = String(change.value);
			const picked = voice.catalog?.voices.find(
				(v) => v.id === (id || voice.catalog?.default_voice),
			);
			const out: Array<{ path: string; change: FieldChange }> = [
				{
					path: "$.larm.style",
					change: picked?.default_style
						? { value: picked.default_style }
						: { unset: true },
				},
			];
			for (const [path, key] of [
				["$.larm.speed", "speed"],
				["$.larm.pitchScale", "pitch_scale"],
				["$.larm.intonationScale", "intonation_scale"],
			] as const) {
				const range = picked?.capabilities[key];
				const current = effective ? readPath(effective, path) : undefined;
				if (
					range &&
					typeof current === "number" &&
					(current < range.minimum || current > range.maximum)
				)
					out.push({ path, change: { value: range.default } });
			}
			return out;
		},
	};
	return access;
}
