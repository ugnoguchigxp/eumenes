import { z } from "zod";
import { settingsSchema } from "../../../../api/domains/settings/contracts";
import { field, type Binding } from "./artifact-definition";

const general = settingsSchema.shape.general.shape;
const subtitles = general.subtitles.removeDefault().shape;
export const displayFields: Binding[] = [
	field({
		id: "display.background",
		storagePath: "$.general.background",
		descriptor: {
			label: "会話の背景",
			control: "select",
			defaultValue: "light-fairy",
			help: "保存すると会話画面の背景を切り替えます。Spatialの状態表示は、実際の機器の計測値にはまだ対応していません。",
			options: [
				{ value: "light-fairy", label: "光の妖精" },
				{ value: "spatial", label: "Spatial" },
			],
		},
		schema: general.background.unwrap(),
		read: (s) => s.general.background ?? "",
		write: (s, value) => {
			if (value === "") delete s.general.background;
			else s.general.background = value;
		},
	}),
	field({
		id: "display.theme",
		storagePath: "$.general.theme",
		descriptor: {
			label: "テーマ",
			control: "select",
			options: [
				{ value: "system", label: "端末の設定に合わせる" },
				{ value: "light", label: "ライト" },
				{ value: "dark", label: "ダーク" },
			],
		},
		schema: general.theme,
		read: (s) => s.general.theme,
		write: (s, value) => {
			s.general.theme = value;
		},
	}),
	field({
		id: "display.subtitles.enabled",
		storagePath: "$.general.subtitles.enabled",
		descriptor: {
			label: "読み上げ字幕を表示する",
			control: "toggle",
			help: "読み上げに合わせて画面中央に字幕を出します。",
		},
		schema: z.enum(["true", "false"]),
		read: (s) => (s.general.subtitles.enabled ? "true" : "false"),
		write: (s, value) => {
			s.general.subtitles.enabled = subtitles.enabled.parse(value === "true");
		},
	}),
	field({
		id: "display.subtitles.style",
		storagePath: "$.general.subtitles.style",
		descriptor: {
			label: "字幕のデザイン",
			control: "select",
			options: [
				{ value: "netflix", label: "シネマ（白文字・影）" },
				{ value: "prime", label: "ボックス（半透明の黒背景）" },
				{ value: "classic", label: "クラシック（黄文字・黒縁）" },
				{ value: "glass", label: "ガラス（ぼかし背景）" },
			],
		},
		schema: subtitles.style,
		read: (s) => s.general.subtitles.style,
		write: (s, value) => {
			s.general.subtitles.style = value;
		},
	}),
	field({
		id: "display.subtitles.size",
		storagePath: "$.general.subtitles.size",
		descriptor: {
			label: "字幕の大きさ",
			control: "select",
			options: [
				{ value: "medium", label: "中" },
				{ value: "large", label: "大" },
				{ value: "xlarge", label: "特大" },
			],
		},
		schema: subtitles.size,
		read: (s) => s.general.subtitles.size,
		write: (s, value) => {
			s.general.subtitles.size = value;
		},
	}),
];
