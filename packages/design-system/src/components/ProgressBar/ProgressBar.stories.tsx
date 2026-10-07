import type { Meta, StoryObj } from "@storybook/react-vite";

import { ProgressBar } from "./ProgressBar";

const meta: Meta<typeof ProgressBar> = {
	title: "Components/ProgressBar",
	component: ProgressBar,
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
type Story = StoryObj<typeof ProgressBar>;

export const Default: Story = {
	args: {
		value: 50,
		label: "Progress",
		subLabel: "50%",
	},
};

export const Striped: Story = {
	args: {
		value: 60,
		label: "Striped",
		subLabel: "60%",
		striped: true,
		animated: false,
	},
};

export const Animated: Story = {
	args: {
		value: 70,
		label: "Animated",
		subLabel: "70%",
		striped: true,
		animated: true,
	},
};

export const Status: Story = {
	render: () => (
		<div className="flex flex-col gap-8 w-full max-w-lg">
			<ProgressBar value={80} label="Normal" subLabel="80%" status="normal" />
			<ProgressBar value={45} label="Paused" subLabel="45%" status="paused" />
			<ProgressBar value={20} label="Error" subLabel="20%" status="error" />
		</div>
	),
};

export const Sizes: Story = {
	render: () => (
		<div className="flex flex-col gap-8 w-full max-w-lg">
			<div>
				<div className="mb-2 text-sm font-semibold">Small (h-2)</div>
				<ProgressBar value={30} height="h-2" />
			</div>
			<div>
				<div className="mb-2 text-sm font-semibold">Default (h-4)</div>
				<ProgressBar value={50} height="h-4" />
			</div>
			<div>
				<div className="mb-2 text-sm font-semibold">Large (h-8)</div>
				<ProgressBar value={70} height="h-8" />
			</div>
		</div>
	),
};

export const AllVariants: Story = {
	render: () => (
		<div className="grid gap-12 w-full max-w-3xl">
			<section>
				<h3 className="mb-4 text-lg font-bold border-b pb-2">Styles</h3>
				<div className="grid gap-6">
					<ProgressBar value={40} label="Default" subLabel="40%" />
					<ProgressBar
						value={50}
						label="Striped"
						subLabel="50%"
						striped
						animated={false}
					/>
					<ProgressBar
						value={60}
						label="Animated"
						subLabel="60%"
						striped
						animated
					/>
				</div>
			</section>

			<section>
				<h3 className="mb-4 text-lg font-bold border-b pb-2">Status Colors</h3>
				<div className="grid gap-6">
					<ProgressBar
						value={75}
						label="Normal"
						subLabel="Interpolated Color"
					/>
					<ProgressBar
						value={40}
						label="Paused"
						subLabel="Yellow"
						status="paused"
					/>
					<ProgressBar value={25} label="Error" subLabel="Red" status="error" />
				</div>
			</section>

			<section>
				<h3 className="mb-4 text-lg font-bold border-b pb-2">
					Interactive Demo
				</h3>
				<div className="p-4 border rounded-lg bg-card/50">
					<ProgressBar
						value={33}
						label="Uploading..."
						subLabel="33%"
						striped
						animated
						height="h-6"
					/>
				</div>
			</section>
		</div>
	),
};
