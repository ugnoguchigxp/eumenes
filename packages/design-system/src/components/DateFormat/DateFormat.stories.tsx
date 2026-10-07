import type { Meta, StoryObj } from "@storybook/react-vite";
import i18n from "i18next";
import { useState } from "react";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { DateFormat } from "./DateFormat";

const storyI18n = i18n.createInstance();
storyI18n.use(initReactI18next).init({
	lng: "en",
	fallbackLng: "en",
	resources: {},
	initImmediate: false,
	react: {
		useSuspense: false,
	},
});

const meta: Meta<typeof DateFormat> = {
	title: "Components/DateFormat",
	component: DateFormat,
	tags: ["autodocs"],
	decorators: [
		(Story) => (
			<>
				<I18nextProvider i18n={storyI18n}>
					<div
						style={{
							padding: "2rem",
							backgroundColor: "hsl(var(--background))",
						}}
					>
						<Story />
					</div>
				</I18nextProvider>
			</>
		),
	],
};

export default meta;
type Story = StoryObj<typeof DateFormat>;

const sampleDate = "2025-12-20T14:30:00Z";

const variantConfigs = [
	{ label: "Date only", props: {} },
	{ label: "With time", props: { showTime: true } },
	{ label: "With day of week", props: { showDayOfWeek: true } },
	{ label: "With both", props: { showTime: true, showDayOfWeek: true } },
	{ label: "Secondary calendar", props: { showSecondary: true } },
];

const locales = [
	{ locale: "en", label: "English (US)" },
	{ locale: "ja", label: "Japanese" },
	{ locale: "ar", label: "Arabic (Saudi)" },
	{ locale: "th", label: "Thai" },
	{ locale: "zh", label: "Chinese (Simplified)" },
];

const createIsolatedI18n = (lng: string) => {
	const instance = i18n.createInstance();
	instance.use(initReactI18next).init({
		lng,
		fallbackLng: "en",
		resources: {},
		initImmediate: false,
		react: { useSuspense: false },
	});
	return instance;
};

const LocaleRow = ({ locale, label }: { locale: string; label: string }) => {
	const [rowI18n] = useState(() => createIsolatedI18n(locale));

	return (
		<I18nextProvider i18n={rowI18n}>
			<section className="mb-6">
				<h3 className="text-lg font-semibold">{label}</h3>
				<div className="mt-2 grid gap-3 md:grid-cols-3">
					{variantConfigs.map(({ label: variantLabel, props }) => (
						<div
							key={`${locale}-${variantLabel}`}
							className="rounded-xl border border-border bg-card p-4 shadow-sm"
						>
							<p className="text-sm text-muted-foreground">{variantLabel}</p>
							<div className="mt-2 text-base font-medium">
								<DateFormat date={sampleDate} {...props} />
							</div>
						</div>
					))}
				</div>
			</section>
		</I18nextProvider>
	);
};

export const Default: Story = {
	args: {
		date: sampleDate,
		showDayOfWeek: true,
		showTime: true,
	},
};

export const LanguageShowcase: Story = {
	render: () => (
		<div className="space-y-10 max-w-3xl">
			<p className="text-sm text-muted-foreground">
				Each row updates the shared i18n language and mirrors the list style
				used across the product. This keeps the typography and spacing
				consistent with the original screens.
			</p>
			{locales.map((item) => (
				<LocaleRow key={item.locale} locale={item.locale} label={item.label} />
			))}
		</div>
	),
};
