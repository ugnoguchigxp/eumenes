import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// text-ui sets the density font size; it must coexist with semantic text colors.
const merge = extendTailwindMerge({
	extend: { classGroups: { "font-size": [{ text: ["ui"] }] } },
});

/**
 * クラス名を条件に応じて結合し、Tailwind CSSのクラス衝突を解決するユーティリティ。
 */
export function cn(...inputs: ClassValue[]) {
	return merge(clsx(inputs));
}
