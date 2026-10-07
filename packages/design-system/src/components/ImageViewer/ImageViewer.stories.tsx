import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Button } from "@/components/Button";

import { ImageViewer } from "./ImageViewer";

const meta: Meta<typeof ImageViewer> = {
	title: "Components/ImageViewer",
	component: ImageViewer,
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
type Story = StoryObj<typeof ImageViewer>;

export const Default: Story = {
	render: () => {
		const [open, setOpen] = useState(false);
		const src =
			"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='640' height='360'><rect width='100%25' height='100%25' fill='%23e5e7eb'/><text x='50%25' y='50%25' dominant-baseline='middle' text-anchor='middle' font-family='sans-serif' font-size='28' fill='%236b7280'>ImageViewer</text></svg>";

		return (
			<div className="flex items-center gap-3">
				<Button onClick={() => setOpen(true)}>Open viewer</Button>
				<ImageViewer
					src={src}
					alt="Preview image"
					open={open}
					onOpenChange={setOpen}
				/>
			</div>
		);
	},
};
