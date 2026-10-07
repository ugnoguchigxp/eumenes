import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "@/components/Button";

import { DropdownMenu } from "./DropdownMenu";

const meta: Meta<typeof DropdownMenu> = {
	title: "Components/DropdownMenu",
	component: DropdownMenu,
	tags: ["autodocs"],
	decorators: [
		(Story) => (
			<>
				<div
					style={{
						padding: "2rem",
						backgroundColor: "hsl(var(--background))",
						minHeight: "60vh",
					}}
				>
					<Story />
				</div>
			</>
		),
	],
};

export default meta;
type Story = StoryObj<typeof DropdownMenu>;

export const Default: Story = {
	render: () => (
		<DropdownMenu
			trigger={<Button variant="outline">Open menu</Button>}
			items={[
				{ label: "Item A", onClick: () => {} },
				{ label: "Item B", onClick: () => {} },
				{ label: "Item C", onClick: () => {} },
			]}
			align="left"
		/>
	),
};

export const AutoFlipNearEdges: Story = {
	render: () => (
		<div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
			<div className="rounded border border-border bg-card p-4">
				<div className="text-sm font-semibold text-foreground mb-2">
					Near right edge
				</div>
				<div className="flex justify-end">
					<DropdownMenu
						trigger={<Button variant="outline">Open</Button>}
						items={Array.from({ length: 8 }).map((_, i) => ({
							label: `Menu item ${i + 1}`,
							onClick: () => {},
						}))}
						align="right"
					/>
				</div>
			</div>

			<div className="rounded border border-border bg-card p-4">
				<div className="text-sm font-semibold text-foreground mb-2">
					Near bottom edge
				</div>
				<div className="h-56 flex items-end">
					<DropdownMenu
						trigger={<Button variant="outline">Open</Button>}
						items={Array.from({ length: 12 }).map((_, i) => ({
							label: `Menu item ${i + 1}`,
							onClick: () => {},
						}))}
						align="left"
					/>
				</div>
			</div>
		</div>
	),
};

export const Mobile: Story = {
	parameters: {
		viewport: { defaultViewport: "iphone6" },
		layout: "fullscreen",
	},
	render: () => (
		<div className="p-4 min-h-screen bg-background">
			<div className="text-sm text-muted-foreground mb-3">
				Mobile viewport (use toolbar to switch sizes)
			</div>
			<div className="flex justify-between items-center">
				<div className="text-sm font-semibold text-foreground">Header</div>
				<DropdownMenu
					trigger={<Button variant="outline">Menu</Button>}
					items={Array.from({ length: 14 }).map((_, i) => ({
						label: `Menu item ${i + 1}`,
						onClick: () => {},
					}))}
					align="right"
				/>
			</div>
			<div className="mt-6 h-[70vh] rounded border border-border bg-card p-3 text-sm text-muted-foreground">
				Scroll/space placeholder
			</div>
		</div>
	),
};
