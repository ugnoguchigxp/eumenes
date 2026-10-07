import type { Meta, StoryObj } from "@storybook/react-vite";

import { ScrollArea } from "./ScrollArea";

const meta: Meta<typeof ScrollArea> = {
	title: "Components/ScrollArea",
	component: ScrollArea,
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
type Story = StoryObj<typeof ScrollArea>;

const rows = Array.from({ length: 20 }, (_, index) => ({
	id: `row-${index + 1}`,
	label: `Scrollable row ${index + 1}`,
}));

export const Default: Story = {
	render: () => (
		<ScrollArea className="h-40 w-full max-w-md rounded border border-border bg-card p-3">
			<div className="space-y-2 text-sm text-foreground">
				{rows.map((row) => (
					<div key={row.id}>{row.label}</div>
				))}
			</div>
		</ScrollArea>
	),
};
