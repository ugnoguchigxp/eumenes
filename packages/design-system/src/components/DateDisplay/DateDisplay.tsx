/**
 * 日付表示コンポーネント
 * 言語設定に応じて適切な形式で日付を表示
 */

import React from "react";

interface DateDisplayProps {
	date: Date;
	/**
	 * 表示形式
	 * - full: 完全な日付と曜日（例: 2025年10月23日（木曜日）、Thursday, 23 October 2025）
	 * - date: 日付のみ（例: 2025年10月23日、23 October 2025）
	 * - weekday: 曜日のみ（例: 木曜日、Thursday）
	 * - weekdayShort: 曜日短縮形（例: 木、Thu）
	 * - yearMonth: 年月のみ（例: 2025年10月、October 2025）
	 * - monthDay: 月日のみ（例: 10月23日、23 October）
	 * - monthDayShort: 月日と曜日短縮形（例: 10/23 (木)、23 Oct (Thu)）
	 * - compact: 超コンパクト（例: 11/27改行(木)、27改行Thu）
	 */
	format?:
		| "full"
		| "date"
		| "weekday"
		| "weekdayShort"
		| "yearMonth"
		| "monthDay"
		| "monthDayShort"
		| "compact";
	className?: string;
	/** Optional locale override (e.g. "ja", "en"). Default: "en" */
	locale?: string;
}

/**
 * 日付表示コンポーネント
 */
export const DateDisplay: React.FC<DateDisplayProps> = React.memo(
	({ date, format = "full", className, locale: localeProp }) => {
		const lang = localeProp || "en";
		const localeStr = lang === "ja" ? "ja-JP" : "en-GB";

		const formatDate = (): string => {
			switch (format) {
				case "weekday":
					// 曜日のみ
					return date.toLocaleDateString(localeStr, { weekday: "long" });

				case "weekdayShort":
					// 曜日短縮形
					return date.toLocaleDateString(localeStr, { weekday: "short" });

				case "yearMonth":
					// 年月のみ
					if (lang === "ja") {
						return `${date.getFullYear()}年${date.getMonth() + 1}月`;
					}
					return date.toLocaleDateString(localeStr, {
						year: "numeric",
						month: "long",
					});

				case "monthDay":
					// 月日のみ
					if (lang === "ja") {
						return `${date.getMonth() + 1}月${date.getDate()}日`;
					}
					// 英語: 23 October
					return date.toLocaleDateString(localeStr, {
						day: "numeric",
						month: "long",
					});

				case "monthDayShort": {
					// 月日と曜日短縮形
					if (lang === "ja") {
						const weekdayShort = date.toLocaleDateString(localeStr, {
							weekday: "short",
						});
						return `${date.getMonth() + 1}/${date.getDate()} (${weekdayShort})`;
					}
					// 英語: 23 Oct (Thu)
					const monthShort = date.toLocaleDateString(localeStr, {
						month: "short",
					});
					const weekdayShort = date.toLocaleDateString(localeStr, {
						weekday: "short",
					});
					return `${date.getDate()} ${monthShort} (${weekdayShort})`;
				}

				case "compact": {
					// 超コンパクト形式（モバイル用）
					if (lang === "ja") {
						const weekdayShort = date.toLocaleDateString(localeStr, {
							weekday: "short",
						});
						return `${date.getMonth() + 1}/${date.getDate()}\n(${weekdayShort})`;
					}
					// 英語: 27\nThu
					const weekdayShort = date.toLocaleDateString(localeStr, {
						weekday: "short",
					});
					return `${date.getDate()}\n${weekdayShort}`;
				}

				case "date":
					// 日付のみ（曜日なし）
					if (lang === "ja") {
						return date.toLocaleDateString(localeStr, {
							year: "numeric",
							month: "long",
							day: "numeric",
						});
					}
					// 英語: 23 October 2025
					return date.toLocaleDateString(localeStr, {
						day: "numeric",
						month: "long",
						year: "numeric",
					});

				default:
					// 完全な日付と曜日
					if (lang === "ja") {
						// 日本語: 2025年10月23日（木曜日）
						const dateStr = date.toLocaleDateString(localeStr, {
							year: "numeric",
							month: "long",
							day: "numeric",
						});
						const weekday = date.toLocaleDateString(localeStr, {
							weekday: "long",
						});
						return `${dateStr}（${weekday}）`;
					}
					// 英語: Thursday, 23 October 2025
					return date.toLocaleDateString(localeStr, {
						weekday: "long",
						day: "numeric",
						month: "long",
						year: "numeric",
					});
			}
		};

		return <span className={className}>{formatDate()}</span>;
	},
);
