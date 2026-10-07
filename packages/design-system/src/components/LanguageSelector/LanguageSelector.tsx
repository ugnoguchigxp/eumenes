import { Globe } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../utils/cn";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../Select/Select";

export interface LanguageOption {
	value: string;
	label: string;
}

interface LanguageSelectorProps {
	className?: string; // Wrapper class
	buttonClassName?: string; // Button specific overrides
	id?: string;
	align?: "left" | "right";
	value?: string;
	onValueChange?: (lng: string) => void | Promise<void>;
	/**
	 * 表示する言語のリスト。未指定時は日本語と英語が表示されます。
	 */
	languages?: LanguageOption[];
}

const DEFAULT_LANGUAGES: LanguageOption[] = [
	{ value: "ja", label: "日本語" },
	{ value: "en", label: "English" },
];

export const LanguageSelector: React.FC<LanguageSelectorProps> = React.memo(
	({
		className = "",
		buttonClassName = "",
		id,
		align = "right",
		value,
		onValueChange,
		languages = DEFAULT_LANGUAGES,
	}) => {
		const { i18n } = useTranslation();

		const changeLanguage = (lng: string) => {
			if (onValueChange) {
				void onValueChange(lng);
			} else {
				void i18n.changeLanguage(lng);
			}

			// Use global fallbacks if available, or console
			// @ts-expect-error globalThis property extension
			const globalLog = globalThis.log;
			if (globalLog && typeof globalLog.info === "function") {
				globalLog.info("Language changed", { language: lng });
			}
		};

		const currentLanguage = value ?? i18n.language ?? "ja";

		return (
			<div className={cn("relative", className)} id={id}>
				<Select value={currentLanguage} onValueChange={changeLanguage}>
					<SelectTrigger
						className={cn("w-auto min-w-[100px]", buttonClassName)}
					>
						<div className="flex items-center gap-2">
							<Globe className="w-[var(--ui-icon-size)] h-[var(--ui-icon-size)]" />
							<SelectValue />
						</div>
					</SelectTrigger>
					<SelectContent align={align === "left" ? "start" : "end"}>
						{languages.map((lang) => (
							<SelectItem key={lang.value} value={lang.value}>
								{lang.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
		);
	},
);

export default LanguageSelector;
