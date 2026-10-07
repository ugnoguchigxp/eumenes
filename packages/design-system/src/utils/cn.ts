import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * クラス名を条件に応じて結合し、Tailwind CSSのクラス衝突を解決するユーティリティ。
 */
export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}
