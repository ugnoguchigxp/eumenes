import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { AdaptiveText } from "./AdaptiveText";

const meta: Meta<typeof AdaptiveText> = {
	title: "Components/AdaptiveText",
	component: AdaptiveText,
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
type Story = StoryObj<typeof AdaptiveText>;

export const Default: Story = {
	args: {
		text: "A very long piece of text that should adapt to the available width.",
		width: 220,
	},
};

const monoStyle = {
	fontFamily:
		'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
} as const;

const sampleText = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export const Behaviors: Story = {
	render: () => (
		<div className="space-y-4">
			<div className="text-sm text-muted-foreground">
				Same text, different widths (monospace) to reproduce: fit / scale /
				truncate.
			</div>

			<div className="space-y-2">
				<div className="text-sm font-semibold text-foreground">
					1) Fits (renders normally)
				</div>
				<div className="rounded border border-border bg-card p-3">
					<AdaptiveText text={sampleText} width={360} style={monoStyle} />
				</div>
			</div>

			<div className="space-y-2">
				<div className="text-sm font-semibold text-foreground">
					2) Slight overflow (≤ 30%) → scales down
				</div>
				<div className="rounded border border-border bg-card p-3">
					<AdaptiveText text={sampleText} width={240} style={monoStyle} />
				</div>
			</div>

			<div className="space-y-2">
				<div className="text-sm font-semibold text-foreground">
					3) Large overflow (&gt; 30%) → truncates with ellipsis
				</div>
				<div className="rounded border border-border bg-card p-3">
					<AdaptiveText text={sampleText} width={160} style={monoStyle} />
				</div>
			</div>
		</div>
	),
};

export const WithInteraction: Story = {
	render: () => {
		const [width, setWidth] = useState(260);
		return (
			<div className="space-y-3">
				<div className="text-sm text-muted-foreground">
					Drag to change width: {width}px (text={sampleText.length} chars)
				</div>
				<input
					type="range"
					min={100}
					max={420}
					value={width}
					onChange={(e) => setWidth(Number(e.target.value))}
					className="w-full"
				/>
				<div className="rounded border border-border bg-card p-3">
					<AdaptiveText text={sampleText} width={width} style={monoStyle} />
				</div>
			</div>
		);
	},
};
