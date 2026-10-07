import type { Meta, StoryObj } from "@storybook/react-vite";

import { CurrencyFormat, NumberFormat, PercentFormat } from "./NumberFormat";

const locales = [
	{ label: "en-US", value: "en-US" },
	{ label: "ja-JP", value: "ja-JP" },
	{ label: "de-DE", value: "de-DE" },
	{ label: "ar", value: "ar" },
	{ label: "th-TH", value: "th-TH" },
];

type NumberRow = {
	label: string;
	value: number;
	options?: Intl.NumberFormatOptions;
};

const numberRows: NumberRow[] = [
	{ label: "Default", value: 12345.678 },
	{ label: "No grouping", value: 12345.678, options: { useGrouping: false } },
	{
		label: "Fixed 2",
		value: 12345.678,
		options: { minimumFractionDigits: 2, maximumFractionDigits: 2 },
	},
	{
		label: "Sign always",
		value: 12345.678,
		options: { signDisplay: "always" },
	},
	{ label: "Negative", value: -12345.678 },
	{
		label: "Compact",
		value: 1250000,
		options: {
			notation: "compact",
			compactDisplay: "short",
			maximumFractionDigits: 1,
		},
	},
	{
		label: "Scientific",
		value: 12345.678,
		options: { notation: "scientific" },
	},
	{
		label: "Significant digits",
		value: 12345.678,
		options: { maximumSignificantDigits: 3 },
	},
];

type CurrencyRow = {
	label: string;
	value: number;
	currency: string;
	options?: Intl.NumberFormatOptions;
};

const currencyRows: CurrencyRow[] = [
	{ label: "USD (symbol)", value: 12345.67, currency: "USD" },
	{
		label: "USD (code)",
		value: 12345.67,
		currency: "USD",
		options: { currencyDisplay: "code" },
	},
	{
		label: "EUR (name)",
		value: 12345.67,
		currency: "EUR",
		options: { currencyDisplay: "name" },
	},
	{ label: "JPY (symbol)", value: 12345, currency: "JPY" },
	{
		label: "SAR (narrow)",
		value: 12345.67,
		currency: "SAR",
		options: { currencyDisplay: "narrowSymbol" },
	},
	{
		label: "Accounting (negative)",
		value: -12345.67,
		currency: "USD",
		options: { currencySign: "accounting" },
	},
];

type PercentRow = {
	label: string;
	value: number;
	options?: Intl.NumberFormatOptions;
	valueScale?: "ratio" | "percent";
};

const percentRows: PercentRow[] = [
	{
		label: "Ratio (0.1234)",
		value: 0.1234,
		options: { maximumFractionDigits: 1 },
	},
	{
		label: "Ratio 2dp",
		value: 0.1234,
		options: { minimumFractionDigits: 2, maximumFractionDigits: 2 },
	},
	{
		label: "Percent (12.34)",
		value: 12.34,
		valueScale: "percent",
		options: { maximumFractionDigits: 1 },
	},
	{
		label: "Percent 0dp",
		value: 12.34,
		valueScale: "percent",
		options: { maximumFractionDigits: 0 },
	},
	{
		label: "Negative",
		value: -0.0567,
		options: { maximumFractionDigits: 1 },
	},
	{
		label: "Sign always",
		value: 0.0567,
		options: { maximumFractionDigits: 1, signDisplay: "always" },
	},
];

const meta: Meta<typeof NumberFormat> = {
	title: "Components/NumberFormat",
	component: NumberFormat,
	tags: ["autodocs"],
	decorators: [
		(Story) => (
			<>
				<div
					style={{ padding: "2rem", backgroundColor: "hsl(var(--background))" }}
				>
					<Story />
				</div>
			</>
		),
	],
};

export default meta;
type Story = StoryObj<typeof NumberFormat>;

export const Default: Story = {
	args: {
		value: 12345.678,
		options: { maximumFractionDigits: 2 },
	},
};

export const Patterns: Story = {
	render: () => (
		<div className="space-y-4">
			<div className="text-sm font-semibold">Locale x Variant Matrix</div>
			<div className="overflow-x-auto">
				<table className="min-w-full border border-border text-sm">
					<thead className="bg-muted/40">
						<tr>
							<th className="px-3 py-2 text-left font-medium text-muted-foreground">
								Variant
							</th>
							{locales.map((locale) => (
								<th
									key={locale.value}
									className="px-3 py-2 text-left font-medium text-muted-foreground"
								>
									{locale.label}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{numberRows.map((row) => (
							<tr key={row.label} className="border-t border-border">
								<th className="px-3 py-2 text-left font-medium">{row.label}</th>
								{locales.map((locale) => (
									<td key={locale.value} className="px-3 py-2">
										<NumberFormat
											value={row.value}
											options={row.options}
											locale={locale.value}
										/>
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	),
};

export const CurrencyPatterns: Story = {
	render: () => (
		<div className="space-y-4">
			<h3 className="text-lg font-semibold">Currency Format Patterns</h3>
			<div className="overflow-x-auto">
				<table className="min-w-full border border-border text-sm">
					<thead className="bg-muted/40">
						<tr>
							<th className="px-3 py-2 text-left font-medium text-muted-foreground">
								Variant
							</th>
							{locales.map((locale) => (
								<th
									key={locale.value}
									className="px-3 py-2 text-left font-medium text-muted-foreground"
								>
									{locale.label}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{currencyRows.map((row) => (
							<tr key={row.label} className="border-t border-border">
								<th className="px-3 py-2 text-left font-medium">{row.label}</th>
								{locales.map((locale) => (
									<td key={locale.value} className="px-3 py-2">
										<CurrencyFormat
											value={row.value}
											currency={row.currency}
											options={row.options}
											locale={locale.value}
										/>
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	),
};

export const PercentPatterns: Story = {
	render: () => (
		<div className="space-y-4">
			<h3 className="text-lg font-semibold">Percent Format Patterns</h3>
			<div className="overflow-x-auto">
				<table className="min-w-full border border-border text-sm">
					<thead className="bg-muted/40">
						<tr>
							<th className="px-3 py-2 text-left font-medium text-muted-foreground">
								Variant
							</th>
							{locales.map((locale) => (
								<th
									key={locale.value}
									className="px-3 py-2 text-left font-medium text-muted-foreground"
								>
									{locale.label}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{percentRows.map((row) => (
							<tr key={row.label} className="border-t border-border">
								<th className="px-3 py-2 text-left font-medium">{row.label}</th>
								{locales.map((locale) => (
									<td key={locale.value} className="px-3 py-2">
										<PercentFormat
											value={row.value}
											valueScale={row.valueScale}
											options={row.options}
											locale={locale.value}
										/>
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	),
};
