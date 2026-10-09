import variablesCss from "../../../../packages/design-system/src/styles/variables.css?raw";
import themesCss from "../../../../packages/design-system/src/styles/themes.css?raw";
import aliasesCss from "../../../../packages/design-system/src/styles/index.css?raw";
import { THEME_COLORS } from "../../../../packages/design-system/src/styles/themes";

// Read the same declarations used by the DesignSystem, including future tokens.
// Aliases are derived values, not a second editable source of truth.
function declarations(css: string): Record<string, string> {
	return Object.fromEntries(
		Array.from(
			css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g),
			([, name, value]) => [name!, value!.trim()],
		),
	);
}
function rules(css: string) {
	return Array.from(
		css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g),
		([, selector, body]) => ({
			selector: selector!.trim(),
			values: declarations(body!),
		}),
	);
}
const sizes = rules(variablesCss);
const palettes = rules(themesCss);
const baseSizes = sizes[0]!.values;
const basePalette = palettes[0]!.values;
export const designTokenAliases = declarations(
	aliasesCss.match(/@theme\s*\{([\s\S]*?)\}/)![1]!,
);
export const designThemes = [
	"light",
	...Object.keys(THEME_COLORS).filter((name) => name !== "light"),
];
export const themeLabels: Record<string, string> = {
	light: "ライト",
	dark: "ダーク",
	tokyonight: "Tokyo Night",
	eclipse: "Eclipse",
	macosclassic: "macOS Classic",
	fire: "Fire",
	classicterminal: "Classic Terminal",
	sakurabloom: "Sakura Bloom",
	leafmint: "Leaf Mint",
	lattecream: "Latte Cream",
	sunshineOrange: "Sunshine Orange",
};
export const radiusPresets = ["0rem", "0.3rem", "0.5rem", "0.75rem", "1rem"];
const tokenLabels: Record<string, string> = {
	"--radius": "角の丸み（基準）",
	"--ui-component-height": "入力部品の高さ",
	"--ui-list-row-height": "リスト行の高さ",
	"--ui-component-padding-x": "入力部品の左右余白",
	"--ui-component-padding-y": "入力部品の上下余白",
	"--ui-button-padding-x": "ボタンの左右余白",
	"--ui-button-padding-y": "ボタンの上下余白",
	"--ui-button-padding-x-tight": "小ボタンの左右余白",
	"--ui-button-padding-y-tight": "小ボタンの上下余白",
	"--ui-gap-base": "部品間の間隔",
	"--ui-tab-height": "タブの高さ",
	"--ui-tab-gap": "タブ間の間隔",
	"--ui-font-size-base": "文字サイズ",
	"--ui-table-cell-padding": "表のセル余白",
	"--ui-touch-target-min": "操作部品の最小サイズ",
	"--ui-icon-size": "アイコンのサイズ",
	"--ui-modal-padding": "ダイアログの余白",
	"--ui-keypad-button-height": "数字キーの高さ",
	"--ui-checkbox-size": "チェックボックスのサイズ",
	"--ui-badge-padding-x": "バッジの左右余白",
	"--ui-badge-padding-y": "バッジの上下余白",
	"--ui-card-padding": "カードの余白",
	"--ui-drawer-width-left": "左ドロワーの幅",
	"--ui-drawer-width-right": "右ドロワーの幅",
	"--ui-step-circle-size": "ステップの丸のサイズ",
	"--ui-switch-width": "スイッチの幅",
	"--ui-switch-height": "スイッチの高さ",
	"--ui-switch-thumb-size": "スイッチのつまみサイズ",
	"--ui-switch-thumb-translate": "スイッチの移動量",
	"--background": "背景",
	"--foreground": "文字",
	"--card": "カード背景",
	"--card-foreground": "カード文字",
	"--popover": "ポップオーバー背景",
	"--popover-foreground": "ポップオーバー文字",
	"--primary": "メイン色",
	"--primary-foreground": "メイン色上の文字",
	"--secondary": "サブ色",
	"--secondary-foreground": "サブ色上の文字",
	"--muted": "控えめな背景",
	"--muted-foreground": "控えめな文字",
	"--accent": "アクセント",
	"--accent-foreground": "アクセント上の文字",
	"--destructive": "エラー",
	"--destructive-foreground": "エラー上の文字",
	"--success": "成功",
	"--success-foreground": "成功色上の文字",
	"--warning": "警告",
	"--warning-foreground": "警告色上の文字",
	"--border": "枠線",
	"--input": "入力の枠線",
	"--ring": "フォーカスの枠線",
	"--chart-1": "グラフ色1",
	"--chart-2": "グラフ色2",
	"--chart-3": "グラフ色3",
	"--chart-4": "グラフ色4",
	"--sidebar-background": "サイドバー背景",
	"--sidebar-foreground": "サイドバー文字",
	"--sidebar-primary": "サイドバーのメイン色",
	"--sidebar-primary-foreground": "サイドバーメイン色上の文字",
	"--sidebar-accent": "サイドバーのアクセント",
	"--sidebar-accent-foreground": "サイドバーアクセント上の文字",
	"--sidebar-border": "サイドバー枠線",
	"--sidebar-ring": "サイドバーフォーカス枠線",
};
export const designTokens = Array.from(
	new Set([...sizes, ...palettes].flatMap((rule) => Object.keys(rule.values))),
).map((name) => ({
	name,
	label: tokenLabels[name] ?? name,
	kind:
		name === "--radius" || name.startsWith("--ui-")
			? ("length" as const)
			: ("color" as const),
	group:
		name === "--radius"
			? "角の丸み"
			: !name.startsWith("--ui-")
				? "色"
				: name.includes("font")
					? "文字"
					: /padding|gap/.test(name)
						? "余白・間隔"
						: "部品の大きさ",
}));
export type DesignToken = (typeof designTokens)[number];
export type DesignTokenOverrides = Record<string, string>;
export function themeTone(theme: string) {
	return THEME_COLORS[theme]?.tone ?? "light";
}
export function resolveDesignTokens(options: {
	theme: string;
	density: string;
	tablet: boolean;
	radius: string;
	overrides: DesignTokenOverrides;
}): Record<string, string> {
	const palette = palettes.find((rule) =>
		rule.selector.includes(`data-theme="${options.theme}"`),
	)?.values;
	const density = sizes.find((rule) =>
		rule.selector.includes(`data-density="${options.density}"`),
	)?.values;
	const tablet = options.tablet
		? sizes.find((rule) => rule.selector.includes("data-tablet-mode"))?.values
		: undefined;
	return {
		...baseSizes,
		...basePalette,
		...palette,
		...density,
		...tablet,
		"--radius": options.radius,
		...options.overrides,
	};
}
export function validDesignToken(token: DesignToken, value: string) {
	// Keep lengths explicit and nonnegative; invalid intermediate input never changes the preview.
	return token.kind === "length"
		? /^(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em)$/.test(value)
		: CSS.supports("color", value) &&
				!/^(?:inherit|initial|unset|revert|currentcolor)$/i.test(value) &&
				!/var\(/i.test(value);
}
