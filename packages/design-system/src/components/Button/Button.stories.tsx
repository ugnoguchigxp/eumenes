import type { Meta, StoryObj } from "@storybook/react-vite";
import { AlertCircle, HelpCircle, Plus } from "lucide-react";
import { Button } from "./Button";

const meta: Meta<typeof Button> = {
	title: "Components/Button",
	component: Button,
	tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof Button>;

export const Default: Story = {
	args: {
		children: "Button",
		variant: "default",
	},
};

export const Secondary: Story = {
	args: {
		children: "Secondary",
		variant: "secondary",
	},
};

export const Destructive: Story = {
	args: {
		children: "Destructive",
		variant: "destructive",
	},
};

export const Outline: Story = {
	args: {
		children: "Outline",
		variant: "outline",
	},
};

export const Ghost: Story = {
	args: {
		children: "Ghost",
		variant: "ghost",
	},
};

export const Link: Story = {
	args: {
		children: "Link",
		variant: "link",
	},
};

export const AllVariants: Story = {
	render: () => (
		<div className="flex flex-col gap-8 p-4">
			<section>
				<h3 className="mb-4 text-lg font-bold">Standard Variants</h3>
				<div className="flex flex-wrap gap-4">
					<Button variant="default">Default</Button>
					<Button variant="secondary">Secondary</Button>
					<Button variant="destructive">Destructive</Button>
					<Button variant="outline">Outline</Button>
					<Button variant="ghost">Ghost</Button>
					<Button variant="link">Link</Button>
				</div>
			</section>

			<section>
				<h3 className="mb-4 text-lg font-bold">Semantic Variants</h3>
				<div className="flex flex-wrap gap-4">
					<Button variant="success">Success</Button>
					<Button variant="warning">Warning</Button>
					<Button variant="info">Info</Button>
				</div>
			</section>

			<section>
				<h3 className="mb-4 text-lg font-bold">Outline Variants</h3>
				<div className="flex flex-wrap gap-4">
					<Button variant="outline-success">Outline Success</Button>
					<Button variant="outline-warning">Outline Warning</Button>
					<Button variant="outline-destructive">Outline Destructive</Button>
				</div>
			</section>

			<section>
				<h3 className="mb-4 text-lg font-bold">Option Variants</h3>
				<div className="flex flex-wrap gap-4">
					<Button variant="option">Option (Unselected)</Button>
					<Button variant="option-active">Option (Selected)</Button>
				</div>
			</section>

			<section>
				<h3 className="mb-4 text-lg font-bold">Circle Variants / FAB</h3>
				<div className="flex flex-wrap gap-4 items-center">
					{/* FAB: uses large icon size + fab variant styles */}
					<Button variant="fab" className="h-14 w-14 rounded-full">
						<Plus className="h-6 w-6" />
					</Button>
					{/* Helper Circles: use circle size */}
					<Button variant="circle-help" size="circle">
						<HelpCircle className="h-4 w-4" />
					</Button>
					<Button variant="circle-alert" size="circle">
						<AlertCircle className="h-4 w-4" />
					</Button>
				</div>
			</section>

			<section>
				<h3 className="mb-4 text-lg font-bold">Sizes</h3>
				<div className="flex flex-wrap items-center gap-4">
					<Button size="sm">Small</Button>
					<Button size="default">Default</Button>
					<Button size="lg">Large</Button>
					<Button size="icon">
						<span className="text-xs">Icon</span>
					</Button>
					<div className="flex items-center gap-2">
						<span className="text-sm">Circle:</span>
						<Button size="circle" variant="outline">
							<Plus className="h-4 w-4" />
						</Button>
					</div>
				</div>
			</section>

			<section>
				<h3 className="mb-4 text-lg font-bold">States</h3>
				<div className="flex flex-wrap gap-4">
					<Button disabled>Disabled</Button>
					<Button loading>Loading</Button>
					<Button success>Success</Button>
					<Button error>Error</Button>
				</div>
			</section>
		</div>
	),
};
