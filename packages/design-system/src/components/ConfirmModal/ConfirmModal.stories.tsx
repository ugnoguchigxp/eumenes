import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Button } from "@/components/Button";

import { ConfirmModal } from "./ConfirmModal";

const meta: Meta<typeof ConfirmModal> = {
	title: "Components/ConfirmModal",
	component: ConfirmModal,
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
type Story = StoryObj<typeof ConfirmModal>;

export const Default: Story = {
	render: () => {
		const [open, setOpen] = useState(false);
		return (
			<div className="flex items-center gap-3">
				<Button onClick={() => setOpen(true)}>Open confirm</Button>
				<ConfirmModal
					open={open}
					onOpenChange={setOpen}
					title="Confirm action"
					description="Are you sure?"
					onConfirm={() => setOpen(false)}
				/>
			</div>
		);
	},
};
