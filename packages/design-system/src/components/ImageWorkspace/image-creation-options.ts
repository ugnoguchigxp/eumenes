/** Explicit UI choices only. No interpretation or classification of the user's theme. */
export const imageStyles = [
	{
		label: "写真・リアル",
		options: ["写真", "フィルム", "シネマティック", "3D"],
	},
	{
		label: "イラスト・絵画",
		options: [
			"水彩",
			"油彩",
			"アニメ",
			"線画",
			"鉛筆画",
			"パステル",
			"浮世絵",
			"ドット絵",
		],
	},
] as const;
export const imageMoods = [
	"落ち着いた",
	"温かい",
	"明るい",
	"幻想的",
	"力強い",
] as const;
export const imageCompositions = [
	"おまかせ",
	"広めの画角",
	"被写体を中央に",
	"クローズアップ",
	"俯瞰",
] as const;
export const imageLighting = [
	"おまかせ",
	"朝の自然光",
	"柔らかな光",
	"夕方の光",
	"夜の照明",
	"逆光",
] as const;
export type ImageCreationOptions = {
	models?: readonly { value: string; label: string; description?: string }[];
	styleGroups: readonly { label: string; options: readonly string[] }[];
	moods: readonly string[];
	compositions: readonly string[];
	lighting: readonly string[];
	defaults: {
		model?: string;
		width: number;
		height: number;
		format: "png" | "webp";
		seed: number;
	};
};
/** Fallback for older saved OpenUI definitions that predate registered screens. */
export const defaultImageCreationOptions: ImageCreationOptions = {
	styleGroups: imageStyles,
	moods: imageMoods,
	compositions: imageCompositions,
	lighting: imageLighting,
	defaults: { width: 512, height: 512, format: "webp", seed: 0 },
};
export type ImageSelection = {
	theme: string;
	styles: string[];
	moods: string[];
	composition: string;
	light: string;
};
export const emptyImageSelection = (
	options: ImageCreationOptions = defaultImageCreationOptions,
): ImageSelection => ({
	theme: "",
	styles: [],
	moods: [],
	composition: options.compositions[0] ?? "",
	light: options.lighting[0] ?? "",
});
/** Serialize selections as data for the existing image planner; never infer unselected details. */
export function imageSelectionText(
	selection: ImageSelection,
	options: ImageCreationOptions = defaultImageCreationOptions,
) {
	const lines = [
		selection.theme.trim() ? `テーマ：${selection.theme.trim()}` : "",
		selection.styles.length ? `画風：${selection.styles.join("、")}` : "",
		selection.moods.length ? `雰囲気：${selection.moods.join("、")}` : "",
		selection.composition !== options.compositions[0]
			? `構図：${selection.composition}`
			: "",
		selection.light !== options.lighting[0] ? `光：${selection.light}` : "",
	];
	return lines.filter(Boolean).join("\n");
}
