import type { Preview } from "@storybook/react-vite";
import React from "react";

import "../src/styles/index.css";
import i18next from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";

// Provide global t/log for components that assume i18n/logger
// (design-system is consumed standalone in Storybook)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GlobalFallbacks = {
	t?: (key: string, fallback?: string) => string;
	log?: {
		info: (...args: unknown[]) => void;
		warn: (...args: unknown[]) => void;
		error: (...args: unknown[]) => void;
		debug: (...args: unknown[]) => void;
	};
};

const g = globalThis as unknown as GlobalFallbacks;
g.t = (key: string, fallback?: string) => fallback ?? key;
g.log = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
};

const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
	lng: "ja",
	fallbackLng: "ja",
	resources: {},
	interpolation: { escapeValue: false },
	react: { useSuspense: false },
});

const preview: Preview = {
	parameters: {
		actions: { argTypesRegex: "^on[A-Z].*" },
		options: {
			storySort: {
				method: "alphabetical",
				locales: "en-US",
			},
		},
		controls: {
			matchers: {
				color: /(background|color)$/i,
				date: /Date$/i,
			},
		},
		backgrounds: { disabled: true },
		layout: "fullscreen",
	},
	globalTypes: {
		theme: {
			description: "Global theme for components",
			defaultValue: "light",
			toolbar: {
				title: "Theme",
				icon: "paintbrush",
				items: [
					{ value: "light", title: "Light" },
					{ value: "dark", title: "Dark" },
					{ value: "tokyonight", title: "Tokyo Night" },
					{ value: "eclipse", title: "Eclipse" },
					{ value: "macosclassic", title: "macOS Classic" },
					{ value: "fire", title: "Fire" },
					{ value: "classicterminal", title: "Classic Terminal" },
					{ value: "sakurabloom", title: "Sakura Bloom" },
					{ value: "leafmint", title: "Leaf Mint" },
					{ value: "lattecream", title: "Latte Cream" },
					{ value: "sunshineOrange", title: "Sunshine Orange" },
				],
				dynamicTitle: true,
			},
		},
		density: {
			description: "UI Density",
			defaultValue: "normal",
			toolbar: {
				title: "Density",
				icon: "expand",
				items: [
					{ value: "compact", title: "Compact" },
					{ value: "normal", title: "Normal" },
					{ value: "spacious", title: "Spacious" },
				],
				dynamicTitle: true,
			},
		},
		radius: {
			description: "Border Radius",
			defaultValue: "0.5",
			toolbar: {
				title: "Radius",
				icon: "circlehollow",
				items: [
					{ value: "0", title: "0" },
					{ value: "0.3", title: "0.3" },
					{ value: "0.5", title: "0.5" },
					{ value: "0.75", title: "0.75" },
					{ value: "1.0", title: "1.0" },
				],
				dynamicTitle: true,
			},
		},
		tabletMode: {
			description: "Tablet Mode (Touch Optimized)",
			defaultValue: "false",
			toolbar: {
				title: "Tablet",
				icon: "tablet",
				items: [
					{ value: "false", title: "Off" },
					{ value: "true", title: "On" },
				],
				dynamicTitle: true,
			},
		},
	},
	decorators: [
		(Story, context) => {
			const theme = context.globals.theme || "light";
			const density = context.globals.density || "normal";
			const radius = context.globals.radius || "0.5";
			const tabletMode = context.globals.tabletMode || "false";

			// Apply settings to document root for global effect
			React.useEffect(() => {
				const root = document.documentElement;
				root.setAttribute("data-theme", theme);
				root.setAttribute("data-density", density);
				if (tabletMode === "true") {
					root.setAttribute("data-tablet-mode", "true");
				} else {
					root.removeAttribute("data-tablet-mode");
				}
				root.style.setProperty("--radius", `${radius}rem`);
			}, [theme, density, radius, tabletMode]);

			return (
				<I18nextProvider i18n={i18n}>
					<div
						style={{
							minHeight: "100vh",
							width: "100%",
							backgroundColor: "var(--color-background)",
							color: "var(--color-foreground)",
							padding: "1rem",
						}}
					>
						<Story />
					</div>
				</I18nextProvider>
			);
		},
	],
};

export default preview;
