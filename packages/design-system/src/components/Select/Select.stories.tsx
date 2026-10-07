import type { Meta, StoryObj } from "@storybook/react-vite";

import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "./Select";

const meta: Meta<typeof Select> = {
	title: "Components/Select",
	component: Select,
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
type Story = StoryObj<typeof Select>;

export const Default: Story = {
	render: () => (
		<div className="max-w-[240px]">
			<Select defaultValue="apple">
				<SelectTrigger variant="default" size="md">
					<SelectValue placeholder="Select a fruit" />
				</SelectTrigger>
				<SelectContent width="stretch">
					<SelectItem value="apple" size="md">
						Apple
					</SelectItem>
					<SelectItem value="banana" size="md">
						Banana
					</SelectItem>
					<SelectItem value="orange" size="md">
						Orange
					</SelectItem>
				</SelectContent>
			</Select>
		</div>
	),
};

export const Variants: Story = {
	render: () => (
		<div className="space-y-4">
			<div className="max-w-sm space-y-2">
				<div className="text-sm font-semibold text-foreground">
					default / md
				</div>
				<Select defaultValue="apple">
					<SelectTrigger variant="default" size="md">
						<SelectValue placeholder="Select a fruit" />
					</SelectTrigger>
					<SelectContent width="stretch">
						<SelectItem value="apple" size="md">
							Apple
						</SelectItem>
						<SelectItem value="banana" size="md">
							Banana
						</SelectItem>
						<SelectItem value="orange" size="md">
							Orange
						</SelectItem>
					</SelectContent>
				</Select>
			</div>

			<div className="max-w-sm space-y-2">
				<div className="text-sm font-semibold text-foreground">
					outline / sm
				</div>
				<Select defaultValue="apple">
					<SelectTrigger variant="outline" size="sm">
						<SelectValue placeholder="Select a fruit" />
					</SelectTrigger>
					<SelectContent width="stretch">
						<SelectItem value="apple" size="sm">
							Apple
						</SelectItem>
						<SelectItem value="banana" size="sm">
							Banana
						</SelectItem>
						<SelectItem value="orange" size="sm">
							Orange
						</SelectItem>
					</SelectContent>
				</Select>
			</div>

			<div className="max-w-sm space-y-2">
				<div className="text-sm font-semibold text-foreground">ghost / lg</div>
				<Select defaultValue="apple">
					<SelectTrigger variant="ghost" size="lg">
						<SelectValue placeholder="Select a fruit" />
					</SelectTrigger>
					<SelectContent width="stretch">
						<SelectItem value="apple" size="lg">
							Apple
						</SelectItem>
						<SelectItem value="banana" size="lg">
							Banana
						</SelectItem>
						<SelectItem value="orange" size="lg">
							Orange
						</SelectItem>
					</SelectContent>
				</Select>
			</div>
		</div>
	),
};
