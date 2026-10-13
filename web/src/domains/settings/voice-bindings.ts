import { z } from "zod";
import type { SettingsInputField } from "@eumenes/design-system";
import {
	asrLanguages,
	settingsSchema,
	resourceSchema,
	type Settings,
} from "../../../../api/domains/settings/contracts";
import type { Binding } from "./artifact-definition";

/** Wire values are strings; conversion and owner schema validation happen here. */
function binding<T>(
	id: string,
	descriptor: Binding["descriptor"],
	schema: z.ZodType<T>,
	read: (s: Settings) => T,
	write: (s: Settings, value: T) => void,
	kind: "string" | "number" | "boolean" | "array",
	storagePath: string,
): Binding {
	const decode = (value: unknown) => {
		if (typeof value !== "string") throw new Error("invalid_value");
		if (kind === "number" && (!value.trim() || !Number.isFinite(Number(value))))
			throw new Error("invalid_number");
		const parsed = schema.parse(
			kind === "number"
				? Number(value)
				: kind === "boolean"
					? z.enum(["true", "false"]).parse(value) === "true"
					: kind === "array"
						? JSON.parse(value)
						: value,
		);
		return kind === "string" ? (value as T) : parsed;
	};
	return {
		id,
		storagePath,
		descriptor,
		read: (s) => {
			const v = read(s);
			return v === undefined
				? ""
				: kind === "array"
					? JSON.stringify(v)
					: String(v);
		},
		edit: (s, value) => write(s, decode(value)),
		restore: (s, saved) => write(s, read(saved)),
	};
}
const voice: {
	[K in keyof Settings["voice"]]: z.ZodType<Settings["voice"][K]>;
} = settingsSchema.shape.voice.shape;
type LocalVoice = Pick<
	Settings["larm"],
	| "voice"
	| "style"
	| "speed"
	| "pitchScale"
	| "intonationScale"
	| "autoIntonation"
	| "autoStrength"
>;
const larm: { [K in keyof LocalVoice]-?: z.ZodType<LocalVoice[K]> } =
	settingsSchema.shape.larm.shape;
function voiceField<K extends keyof Settings["voice"]>(
	key: K,
	id: string,
	label: string,
	group: string,
	control: SettingsInputField["control"],
	kind: "string" | "number" | "boolean",
	extra: Partial<Binding["descriptor"]> = {},
) {
	return binding<Settings["voice"][K]>(
		id,
		{ label, group, control, ...extra },
		voice[key],
		(s) => s.voice[key],
		(s, v) => {
			s.voice[key] = v;
		},
		kind,
		"$.voice." + key,
	);
}
function localField(
	key: keyof LocalVoice,
	label: string,
	control: SettingsInputField["control"],
	kind: "string" | "number" | "boolean",
	extra: Partial<Binding["descriptor"]> = {},
) {
	return binding<string | number | boolean | undefined>(
		"speech.local." + key,
		{ label, control, group: "speech", ...extra },
		larm[key],
		(s) => s.larm[key],
		(s, v) => {
			Object.assign(s.larm, { [key]: v });
		},
		kind,
		"$.larm." + key,
	);
}
export const voiceFields: Binding[] = [
	voiceField(
		"autoSpeak",
		"speech.enabled",
		"回答を読み上げる",
		"speech",
		"toggle",
		"boolean",
		{ help: "オフでも回答のテキストは会話に残ります。" },
	),
	voiceField(
		"outputVolume",
		"speech.volume",
		"音量",
		"speech",
		"range",
		"number",
		{ minimum: 0, maximum: 1, step: 0.05 },
	),
	voiceField(
		"bargeIn",
		"speech.barge-in",
		"話し始めたら読み上げを止める",
		"speech",
		"toggle",
		"boolean",
	),
	binding(
		"input.languages",
		{
			label: "利用する言語",
			control: "multiple",
			group: "input",
			options: asrLanguages.map(([value, label]) => ({ value, label })),
			help: "聞き取り結果に許可する言語です。最低1つ選んでください。",
		},
		settingsSchema.shape.general.shape.asrLanguages,
		(s) => s.general.asrLanguages,
		(s, v) => {
			s.general.asrLanguages = v;
		},
		"array",
		"$.general.asrLanguages",
	),
	voiceField(
		"threshold",
		"input.threshold",
		"声を検出するしきい値",
		"input",
		"number",
		"number",
		{
			detail: true,
			minimum: 0.001,
			maximum: 0.1,
			step: 0.001,
			help: "小さい値ほど小さな声を拾います。",
		},
	),
	voiceField(
		"silenceMs",
		"input.silence-ms",
		"発話を確定する無音時間（ミリ秒）",
		"input",
		"number",
		"number",
		{
			detail: true,
			minimum: 300,
			maximum: 3000,
			step: 100,
			help: "標準は1500ミリ秒（1.5秒）です。",
		},
	),
	voiceField(
		"echoCancellation",
		"input.echo",
		"エコーを抑える",
		"input",
		"toggle",
		"boolean",
		{ detail: true },
	),
	voiceField(
		"noiseSuppression",
		"input.noise",
		"周囲の雑音を抑える",
		"input",
		"toggle",
		"boolean",
		{ detail: true },
	),
	voiceField(
		"autoGainControl",
		"input.gain",
		"マイクの音量を自動調整する",
		"input",
		"toggle",
		"boolean",
		{ detail: true },
	),
	voiceField(
		"inputDevice",
		"input.device",
		"マイク",
		"devices",
		"select",
		"string",
	),
	voiceField(
		"outputDevice",
		"output.device",
		"再生機器",
		"devices",
		"select",
		"string",
	),
];
export const localVoiceFields: Binding[] = [
	localField("voice", "キャラクター", "select", "string", { searchable: true }),
	localField("style", "話し方（スタイル）", "select", "string", {
		detail: true,
	}),
	localField("speed", "話す速さ", "range", "number", {
		defaultValue: "1",
		step: 0.1,
	}),
	localField("pitchScale", "声の高さ", "range", "number", {
		defaultValue: "0",
		detail: true,
		step: 0.01,
	}),
	localField("intonationScale", "抑揚", "range", "number", {
		defaultValue: "1",
		detail: true,
		step: 0.05,
	}),
	localField(
		"autoIntonation",
		"文章に合わせて抑揚・速さ・高さを変える（簡易）",
		"toggle",
		"boolean",
		{ defaultValue: "false", detail: true },
	),
	localField("autoStrength", "自動調整の強さ", "range", "number", {
		defaultValue: "1",
		minimum: 0,
		maximum: 2,
		step: 0.05,
		detail: true,
	}),
];
export function cloudVoiceFields(settings: Settings): Binding[] {
	return settings.resources
		.filter((r) => r.purpose === "tts")
		.flatMap((r) => {
			const name =
				settings.connections.find((c) => c.id === r.connectionId)?.name ??
				"登録モデル";
			const read = (s: Settings) => s.resources.find((x) => x.id === r.id)!;
			return [
				binding(
					"speech.cloud." + r.id + ".voice",
					{
						label: name + " / " + r.model + " の音声ID",
						control: "text",
						group: "speech",
						maxLength: 200,
						help: "サービスが提供する音声IDを入力してください。",
					},
					resourceSchema.shape.voice.unwrap(),
					(s) => read(s).voice!,
					(s, v) => {
						read(s).voice = v;
					},
					"string",
					`$.resources[id=${r.id}].voice`,
				),
				binding(
					"speech.cloud." + r.id + ".speed",
					{
						label: "話す速さ",
						control: "range",
						group: "speech",
						defaultValue: "1",
						minimum: 0.5,
						maximum: 2,
						step: 0.1,
					},
					resourceSchema.shape.speed,
					(s) => read(s).speed,
					(s, v) => {
						read(s).speed = v;
					},
					"number",
					`$.resources[id=${r.id}].speed`,
				),
			];
		});
}
export function allVoiceFields(settings: Settings) {
	return [...voiceFields, ...localVoiceFields, ...cloudVoiceFields(settings)];
}
export function inputField(
	field: Binding,
	settings: Settings,
): SettingsInputField {
	return { ...field.descriptor, id: field.id, value: field.read(settings) };
}
