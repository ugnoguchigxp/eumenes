import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Button } from "@/components/Button";

import { KeypadModal } from "./KeypadModal";

const meta: Meta<typeof KeypadModal> = {
	title: "Components/KeypadModal",
	component: KeypadModal,
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
type Story = StoryObj<typeof KeypadModal>;

export const NumberKeypad: Story = {
	render: () => {
		const [open, setOpen] = useState(false);
		const [value, setValue] = useState("123");

		return (
			<div className="flex items-center gap-3">
				<Button onClick={() => setOpen(true)}>Open Number Keypad</Button>
				<div className="text-sm text-muted-foreground">Value: {value}</div>
				<KeypadModal
					open={open}
					onClose={() => setOpen(false)}
					initialValue={value}
					onSubmit={(next) => setValue(next)}
					variant="number"
					allowDecimal
				/>
			</div>
		);
	},
};

export const PhoneKeypad: Story = {
	render: () => {
		const [open, setOpen] = useState(false);
		const [value, setValue] = useState("090-1234-5678");

		return (
			<div className="flex items-center gap-3">
				<Button onClick={() => setOpen(true)}>Open Phone Keypad</Button>
				<div className="text-sm text-muted-foreground">Value: {value}</div>
				<KeypadModal
					open={open}
					onClose={() => setOpen(false)}
					initialValue={value}
					onSubmit={(next) => setValue(next)}
					variant="phone"
				/>
			</div>
		);
	},
};

export const TimeKeypad: Story = {
	render: () => {
		const [open, setOpen] = useState(false);
		const [value, setValue] = useState("0900");

		return (
			<div className="flex items-center gap-3">
				<Button onClick={() => setOpen(true)}>Open Time Keypad</Button>
				<div className="text-sm text-muted-foreground">Value: {value}</div>
				<KeypadModal
					open={open}
					onClose={() => setOpen(false)}
					initialValue={value}
					onSubmit={(next) => setValue(next)}
					variant="time"
				/>
			</div>
		);
	},
};

export const Mobile: Story = {
	parameters: {
		viewport: {
			defaultViewport: "mobile1",
		},
		layout: "fullscreen",
	},
	render: () => {
		const [open, setOpen] = useState(true);
		const [value, setValue] = useState("");

		return (
			<div className="w-full max-w-[375px] mx-auto border-x min-h-screen bg-background p-4 flex flex-col justify-center items-center">
				<Button onClick={() => setOpen(true)}>Open Keypad</Button>
				<div className="mt-4">Value: {value}</div>
				<KeypadModal
					open={open}
					onClose={() => setOpen(false)}
					initialValue={value}
					onSubmit={(next) => setValue(next)}
					variant="number"
				/>
			</div>
		);
	},
};
