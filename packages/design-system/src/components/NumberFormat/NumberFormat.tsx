const DEFAULT_FALLBACK = "-";

const getDocumentNumberLocale = (): string | undefined => {
	if (typeof document === "undefined") return undefined;
	const attr = document.documentElement.getAttribute(
		"data-number-format-locale",
	);
	return attr?.trim() ? attr : undefined;
};

const resolveLocale = (localeOverride?: string): string => {
	if (localeOverride) return localeOverride;
	const documentLocale = getDocumentNumberLocale();
	if (documentLocale) return documentLocale;
	if (typeof Intl !== "undefined" && Intl.NumberFormat) {
		return new Intl.NumberFormat().resolvedOptions().locale;
	}
	return "en-US";
};

const formatNumberValue = (
	value: number,
	locale: string,
	options: Intl.NumberFormatOptions | undefined,
	fallback: string,
): string => {
	try {
		return new Intl.NumberFormat(locale, options).format(value);
	} catch {
		try {
			return new Intl.NumberFormat("en-US", options).format(value);
		} catch {
			return fallback ?? String(value);
		}
	}
};

type BaseFormatProps = {
	value: number | null | undefined;
	className?: string;
	locale?: string;
	options?: Intl.NumberFormatOptions;
	fallback?: string;
};

export type NumberFormatProps = BaseFormatProps;

export const NumberFormat = ({
	value,
	className,
	locale,
	options,
	fallback = DEFAULT_FALLBACK,
}: NumberFormatProps) => {
	if (value === null || value === undefined || !Number.isFinite(value)) {
		return <span className={className}>{fallback}</span>;
	}

	const resolvedLocale = resolveLocale(locale);
	const formatted = formatNumberValue(value, resolvedLocale, options, fallback);

	return <span className={className}>{formatted}</span>;
};

export type CurrencyFormatProps = BaseFormatProps & {
	currency: string;
};

export const CurrencyFormat = ({
	value,
	className,
	locale,
	options,
	fallback = DEFAULT_FALLBACK,
	currency,
}: CurrencyFormatProps) => {
	if (value === null || value === undefined || !Number.isFinite(value)) {
		return <span className={className}>{fallback}</span>;
	}

	const resolvedLocale = resolveLocale(locale);
	const formatOptions: Intl.NumberFormatOptions = {
		...options,
		style: "currency",
		currency,
	};
	const formatted = formatNumberValue(
		value,
		resolvedLocale,
		formatOptions,
		fallback,
	);

	return <span className={className}>{formatted}</span>;
};

export type PercentValueScale = "ratio" | "percent";

export type PercentFormatProps = BaseFormatProps & {
	valueScale?: PercentValueScale;
};

export const PercentFormat = ({
	value,
	className,
	locale,
	options,
	fallback = DEFAULT_FALLBACK,
	valueScale = "ratio",
}: PercentFormatProps) => {
	if (value === null || value === undefined || !Number.isFinite(value)) {
		return <span className={className}>{fallback}</span>;
	}

	const resolvedLocale = resolveLocale(locale);
	const scaledValue = valueScale === "percent" ? value / 100 : value;
	const defaultMaxFractionDigits =
		options?.maximumFractionDigits ?? options?.minimumFractionDigits ?? 1;
	const formatOptions: Intl.NumberFormatOptions = {
		maximumFractionDigits: defaultMaxFractionDigits,
		...options,
		style: "percent",
	};
	const formatted = formatNumberValue(
		scaledValue,
		resolvedLocale,
		formatOptions,
		fallback,
	);

	return <span className={className}>{formatted}</span>;
};
