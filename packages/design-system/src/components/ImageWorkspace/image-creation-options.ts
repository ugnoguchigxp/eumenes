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
export type ImageSelection = {
	theme: string;
	styles: string[];
	moods: string[];
	composition: string;
	light: string;
};
export const emptyImageSelection = (): ImageSelection => ({
	theme: "",
	styles: [],
	moods: [],
	composition: "おまかせ",
	light: "おまかせ",
});
/** Serialize selections as data for the existing image planner; never infer unselected details. */
export function imageSelectionText(selection: ImageSelection) {
	const lines = [
		selection.theme.trim() ? `テーマ：${selection.theme.trim()}` : "",
		selection.styles.length ? `画風：${selection.styles.join("、")}` : "",
		selection.moods.length ? `雰囲気：${selection.moods.join("、")}` : "",
		selection.composition !== "おまかせ"
			? `構図：${selection.composition}`
			: "",
		selection.light !== "おまかせ" ? `光：${selection.light}` : "",
	];
	return lines.filter(Boolean).join("\n");
}
