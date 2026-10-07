import type { Meta, StoryObj } from "@storybook/react-vite";

import { Input } from "./Input";

const meta: Meta<typeof Input> = {
	title: "Components/Input",
	component: Input,
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
type Story = StoryObj<typeof Input>;

export const Defaults: Story = {
	render: () => (
		<div className="flex flex-col gap-4 max-w-sm">
			<Input placeholder="Default Input" />
			<Input placeholder="Disabled Input" disabled />
		</div>
	),
};

export const Types: Story = {
	render: () => (
		<div className="flex flex-col gap-4 max-w-sm">
			<div className="grid gap-2">
				<label className="text-sm font-medium" htmlFor="input-text">
					Text
				</label>
				<Input id="input-text" type="text" placeholder="Text input" />
			</div>
			<div className="grid gap-2">
				<label className="text-sm font-medium" htmlFor="input-password">
					Password
				</label>
				<Input
					id="input-password"
					type="password"
					placeholder="Password input"
				/>
			</div>
			<div className="grid gap-2">
				<label className="text-sm font-medium" htmlFor="input-email">
					Email
				</label>
				<Input id="input-email" type="email" placeholder="Email input" />
			</div>
			<div className="grid gap-2">
				<label className="text-sm font-medium" htmlFor="input-number">
					Number
				</label>
				<Input id="input-number" type="number" placeholder="Number input" />
			</div>
			<div className="grid gap-2">
				<label className="text-sm font-medium" htmlFor="input-search">
					Search
				</label>
				<Input id="input-search" type="search" placeholder="Search input" />
			</div>
			<div className="grid gap-2">
				<label className="text-sm font-medium" htmlFor="input-date">
					Date
				</label>
				<Input id="input-date" type="date" />
			</div>
			<div className="grid gap-2">
				<label className="text-sm font-medium" htmlFor="input-file">
					File
				</label>
				<Input id="input-file" type="file" />
			</div>
		</div>
	),
};

export const Mobile: Story = {
	parameters: {
		viewport: {
			defaultViewport: "mobile1",
		},
		layout: "fullscreen",
	},
	render: () => (
		<div className="w-full max-w-[375px] mx-auto border-x min-h-screen bg-background p-4 flex flex-col gap-6">
			<h3 className="text-lg font-bold text-center border-b pb-2">
				Mobile View
			</h3>

			<div className="space-y-4">
				<div>
					<label
						className="block text-sm font-medium mb-1"
						htmlFor="mobile-username"
					>
						Username
					</label>
					<Input
						id="mobile-username"
						type="text"
						placeholder="Enter username"
					/>
					<p className="text-xs text-muted-foreground mt-1">
						Font size 16px prevents iOS zoom.
					</p>
				</div>

				<div>
					<label
						className="block text-sm font-medium mb-1"
						htmlFor="mobile-password"
					>
						Password
					</label>
					<Input
						id="mobile-password"
						type="password"
						placeholder="Enter password"
					/>
				</div>

				<div>
					<label
						className="block text-sm font-medium mb-1"
						htmlFor="mobile-birth-date"
					>
						Birth Date
					</label>
					<Input id="mobile-birth-date" type="date" />
				</div>

				<button
					type="button"
					className="w-full h-12 bg-primary text-white rounded-md font-bold mt-4"
				>
					Submit
				</button>
			</div>
		</div>
	),
};

export const AllVariants: Story = {
	render: () => (
		<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
			<section className="space-y-4">
				<h3 className="font-bold border-b pb-2">Basic Text</h3>
				<Input placeholder="Default" />
				<Input placeholder="Disabled" disabled />
				<Input placeholder="Read Only" readOnly value="Read only value" />
			</section>

			<section className="space-y-4">
				<h3 className="font-bold border-b pb-2">Data Types</h3>
				<Input type="email" placeholder="Email: user@example.com" />
				<Input type="password" placeholder="Password" />
				<Input type="search" placeholder="Search..." />
				<Input type="tel" placeholder="Tel: 090-1234-5678" />
				<Input type="url" placeholder="URL: https://example.com" />
			</section>

			<section className="space-y-4">
				<h3 className="font-bold border-b pb-2">Numeric & Time</h3>
				<Input type="number" placeholder="Number" />
				<Input type="date" />
				<Input type="time" />
				<Input type="datetime-local" />
			</section>

			<section className="space-y-4">
				<h3 className="font-bold border-b pb-2">File</h3>
				<Input type="file" />
			</section>
		</div>
	),
};
