import type { Meta, StoryObj } from "@storybook/react-vite";
import * as React from "react";
import { Button } from "../Button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "./Collapsible";

const meta = {
	title: "Components/Collapsible",
	component: Collapsible,
	parameters: {
		layout: "centered",
	},
	tags: ["autodocs"],
	argTypes: {
		open: {
			control: "boolean",
			description: "The controlled open state of the collapsible.",
		},
		defaultOpen: {
			control: "boolean",
			description: "The default open state when initially rendered.",
		},
		onOpenChange: {
			action: "open changed",
			description: "Event handler called when the open state changes.",
		},
		disabled: {
			control: "boolean",
			description:
				"When true, prevents the user from interacting with the collapsible.",
		},
	},
} satisfies Meta<typeof Collapsible>;

export default meta;
type Story = StoryObj<typeof meta>;

// Basic Collapsible example
export const Default: Story = {
	render: (args) => {
		const [isOpen, setIsOpen] = React.useState(false);

		return (
			<Collapsible
				open={isOpen}
				onOpenChange={setIsOpen}
				className="w-[350px] space-y-2 border rounded p-4"
				{...args}
			>
				<div className="flex items-center justify-between space-x-4 px-4">
					<h4 className="text-sm font-semibold">
						@peduarte starred 3 repositories
					</h4>
					<CollapsibleTrigger asChild>
						<Button variant="ghost" size="sm" className="w-9 p-0">
							<span className="sr-only">Toggle</span>
							<div className="grid h-4 w-4 place-items-center">
								{isOpen ? (
									<svg
										xmlns="http://www.w3.org/2000/svg"
										width="24"
										height="24"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										strokeLinejoin="round"
										className="h-4 w-4"
									>
										<title>Collapse</title>
										<path d="m18 15-6-6-6 6" />
									</svg>
								) : (
									<svg
										xmlns="http://www.w3.org/2000/svg"
										width="24"
										height="24"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										strokeLinejoin="round"
										className="h-4 w-4"
									>
										<title>Expand</title>
										<path d="m6 9 6 6 6-6" />
									</svg>
								)}
							</div>
						</Button>
					</CollapsibleTrigger>
				</div>
				<div className="rounded-md border px-4 py-3 font-mono text-sm">
					@radix-ui/primitives
				</div>
				<CollapsibleContent className="space-y-2">
					<div className="rounded-md border px-4 py-3 font-mono text-sm">
						@radix-ui/colors
					</div>
					<div className="rounded-md border px-4 py-3 font-mono text-sm">
						@stitches/react
					</div>
				</CollapsibleContent>
			</Collapsible>
		);
	},
};

// Disabled state
export const Disabled: Story = {
	args: {
		disabled: true,
	},
	render: (args) => (
		<Collapsible className="w-[350px] space-y-2 border rounded p-4" {...args}>
			<div className="flex items-center justify-between space-x-4 px-4">
				<h4 className="text-sm font-semibold">Disabled Collapsible</h4>
				<CollapsibleTrigger asChild>
					<Button variant="ghost" size="sm" className="w-9 p-0" disabled>
						<div className="grid h-4 w-4 place-items-center">
							<svg
								xmlns="http://www.w3.org/2000/svg"
								width="24"
								height="24"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
								className="h-4 w-4"
							>
								<title>Expand</title>
								<path d="m6 9 6 6 6-6" />
							</svg>
						</div>
					</Button>
				</CollapsibleTrigger>
			</div>
			<CollapsibleContent className="space-y-2">
				<div className="rounded-md border px-4 py-3 font-mono text-sm">
					Content 1
				</div>
			</CollapsibleContent>
		</Collapsible>
	),
};
