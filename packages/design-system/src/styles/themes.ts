// ============================================
// Theme Types
// ============================================

export type ThemeName =
	| "dark"
	| "tokyonight"
	| "eclipse"
	| "macosclassic"
	| "fire"
	| "classicterminal"
	| "sakurabloom"
	| "leafmint"
	| "lattecream"
	| "sunshineOrange"
	| "light"
	| (string & {});

export type ThemeTone = "light" | "dark";

export interface IThemeColors {
	tone: ThemeTone;
	// Colors are now handled by CSS variables.
	// This interface is kept for backward compatibility if needed,
	// but strictly speaking we don't need JS values anymore.
}

export const THEME_CONSTANTS = {
	LIGHT: "light",
	DARK: "dark",
} as const;

// Minimal metadata map if needed, or remove if unused.
// Providing tone mapping might be useful for JS logic like "isDarkMode"
export const THEME_COLORS: Record<ThemeName, { tone: ThemeTone }> = {
	dark: { tone: "dark" },
	tokyonight: { tone: "dark" },
	eclipse: { tone: "light" },
	macosclassic: { tone: "light" },
	fire: { tone: "dark" },
	classicterminal: { tone: "dark" },
	sakurabloom: { tone: "light" },
	leafmint: { tone: "light" },
	lattecream: { tone: "light" },
	sunshineOrange: { tone: "light" },
	light: { tone: "light" },
};

export const DEFAULT_THEME: ThemeName = "light";
