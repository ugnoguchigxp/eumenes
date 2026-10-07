import { useMemo } from "react";
import {
	type CalendarSystem,
	type SecondaryCalendar,
	useCalendarSettings,
} from "@/contexts/CalendarContext";

/** Get browser/navigator locale with fallback */
const getBrowserLocale = (): string => {
	if (typeof navigator !== "undefined" && navigator.language) {
		return navigator.language;
	}
	return "en-US";
};

interface IDateFormatProps {
	/** The date to format (string or Date object) */
	date: string | Date | null | undefined;
	/** Whether to show the day of the week (e.g. "(Mon)") */
	showDayOfWeek?: boolean;
	/** Whether to show the time (e.g. "14:30") */
	showTime?: boolean;
	/** Optional custom class name */
	className?: string;
	/** Optional calendar system override (defaults to display settings) */
	calendar?: CalendarSystem;
	/** Optional secondary calendar to show alongside primary */
	showSecondary?: boolean;
	/** Optional locale override (defaults to navigator.language) */
	locale?: string;
}

const getCalendarBaseLocale = (
	calendarSystem: CalendarSystem,
	fallbackLocale: string,
): string => {
	const lc = fallbackLocale.toLowerCase();
	switch (calendarSystem) {
		case "japanese":
			return lc.startsWith("ja") ? fallbackLocale : "ja-JP";
		case "buddhist":
			return lc.startsWith("th") ? fallbackLocale : "th-TH";
		case "islamic":
			return lc.startsWith("ar") ? fallbackLocale : "ar-SA";
		case "chinese":
			return lc.startsWith("zh") ? fallbackLocale : "zh-CN";
		default:
			return fallbackLocale;
	}
};

const buildOptions = (
	calendarSystem: CalendarSystem,
	locale: string,
	showTime: boolean,
	showDayOfWeek: boolean,
): Intl.DateTimeFormatOptions => {
	const options: Intl.DateTimeFormatOptions = {
		year: "numeric",
		month: locale.startsWith("ja") ? "2-digit" : "short",
		day: "2-digit",
	};

	if (calendarSystem === "japanese" && locale.startsWith("ja")) {
		options.era = "long";
		options.month = "long";
		options.day = "numeric";
	}

	if (showTime) {
		options.hour = "2-digit";
		options.minute = "2-digit";
	}

	if (showDayOfWeek) {
		options.weekday = "short";
	}

	return options;
};

// Global cache for formatters to avoid re-creation across many instances in a list
const formatterCache = new Map<string, Intl.DateTimeFormat>();

export const resetFormatterCache = () => {
	formatterCache.clear();
};

const getCachedFormatter = (
	locale: string,
	options: Intl.DateTimeFormatOptions,
) => {
	const key = `${locale}-${JSON.stringify(options)}`;
	if (!formatterCache.has(key)) {
		formatterCache.set(key, new Intl.DateTimeFormat(locale, options));
	}
	return formatterCache.get(key) as Intl.DateTimeFormat;
};

const formatWithFallback = (
	date: Date,
	localeCandidate: string,
	fallbackLocale: string,
	options: Intl.DateTimeFormatOptions,
	calendarSystem: CalendarSystem,
): string => {
	const format = (fmt: Intl.DateTimeFormat) => {
		if (calendarSystem === "islamic") {
			const parts = fmt.formatToParts(date);
			const withoutEra = parts
				.filter((p) => p.type !== "era")
				.map((p) => p.value)
				.join("");
			return withoutEra.replace(/\s{2,}/g, " ").trim();
		}
		return fmt.format(date);
	};

	try {
		return format(getCachedFormatter(localeCandidate, options));
	} catch {
		return format(getCachedFormatter(fallbackLocale, options));
	}
};

export const DateFormat = ({
	date,
	showDayOfWeek = false,
	showTime = false,
	className,
	calendar,
	showSecondary = false,
	locale: localeProp,
}: IDateFormatProps) => {
	const { secondaryCalendar, preferLocalCalendar } = useCalendarSettings();
	const locale = localeProp || getBrowserLocale();
	const d = useMemo(() => {
		if (!date) return null;
		if (date instanceof Date) return date;
		const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(date);
		if (m) {
			const y = Number(m[1]);
			const mo = Number(m[2]);
			const da = Number(m[3]);
			return new Date(y, mo - 1, da);
		}
		return new Date(date);
	}, [date]);

	// Determine calendar system
	const effectiveCalendar = useMemo(() => {
		if (calendar) return calendar;
		if (preferLocalCalendar) {
			if (locale.startsWith("ja")) return "japanese";
			if (locale.startsWith("ar")) return "islamic";
			if (locale.startsWith("th")) return "buddhist";
			if (locale.startsWith("zh")) return "chinese";
			return "gregorian";
		}
		return "gregorian";
	}, [calendar, preferLocalCalendar, locale]);

	// Debug logging for test failures
	// console.log("DateFormat Render:", { locale, calendar, preferLocalCalendar, secondaryCalendar, effectiveCalendar, showSecondary });

	const formattedDate = useMemo(() => {
		if (!d || Number.isNaN(d.getTime())) {
			return "-";
		}
		let localeWithCalendar = locale;
		if (effectiveCalendar !== "gregorian") {
			const baseLocale = getCalendarBaseLocale(effectiveCalendar, locale);
			const calendarMap = {
				japanese: "japanese",
				buddhist: "buddhist",
				islamic: "islamic",
				chinese: "chinese",
			} as const;
			localeWithCalendar = `${baseLocale}-u-ca-${calendarMap[effectiveCalendar as Exclude<CalendarSystem, "gregorian">]}`;
		}
		const options = buildOptions(
			effectiveCalendar,
			locale,
			showTime,
			showDayOfWeek,
		);
		return formatWithFallback(
			d,
			localeWithCalendar,
			locale,
			options,
			effectiveCalendar,
		);
	}, [effectiveCalendar, locale, showTime, showDayOfWeek, d]);

	const secondaryFormattedDate = useMemo(() => {
		if (!d || Number.isNaN(d.getTime())) {
			return null;
		}
		if (
			showSecondary &&
			!preferLocalCalendar &&
			secondaryCalendar !== "none" &&
			secondaryCalendar !== effectiveCalendar
		) {
			const secondaryCalendarMap: Record<
				Exclude<SecondaryCalendar, "none">,
				string
			> = {
				japanese: "japanese",
				buddhist: "buddhist",
				islamic: "islamic",
				chinese: "chinese",
			};
			const secondaryBaseLocale = getCalendarBaseLocale(
				secondaryCalendar,
				locale,
			);
			const secondaryLocale = `${secondaryBaseLocale}-u-ca-${secondaryCalendarMap[secondaryCalendar as Exclude<SecondaryCalendar, "none">]}`;
			const options = buildOptions(
				secondaryCalendar,
				locale,
				showTime,
				showDayOfWeek,
			);
			return formatWithFallback(
				d,
				secondaryLocale,
				locale,
				options,
				secondaryCalendar,
			);
		}
		return null;
	}, [
		showSecondary,
		preferLocalCalendar,
		secondaryCalendar,
		effectiveCalendar,
		locale,
		showTime,
		showDayOfWeek,
		d,
	]);

	if (formattedDate === "-") {
		return <span className={className}>-</span>;
	}

	return (
		<span className={className}>
			{formattedDate}
			{secondaryFormattedDate && (
				<span className="text-muted-foreground ms-2">
					({secondaryFormattedDate})
				</span>
			)}
		</span>
	);
};
