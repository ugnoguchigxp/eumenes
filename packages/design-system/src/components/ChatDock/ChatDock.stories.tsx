import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { ChatDock } from "./ChatDock";

const meta: Meta<typeof ChatDock> = {
	title: "Components/ChatDock",
	component: ChatDock,
	tags: ["autodocs"],
	decorators: [
		(Story) => (
			<>
				<div
					style={{
						minHeight: "60vh",
						padding: "2rem",
						backgroundColor: "hsl(var(--background))",
					}}
				>
					<Story />
				</div>
			</>
		),
	],
};

export default meta;

type Story = StoryObj<typeof ChatDock>;

const DemoContent = () => (
	<div className="flex flex-col gap-3 text-sm text-foreground">
		<p>Ask a question and the assistant will respond using project docs.</p>
		<div className="rounded-xl bg-muted px-3 py-2">
			This is a sample response bubble.
		</div>
	</div>
);

export const Default: Story = {
	render: () => {
		const [open, setOpen] = useState(false);
		return (
			<ChatDock
				isOpen={open}
				onOpen={() => setOpen(true)}
				onClose={() => setOpen(false)}
				title="chatbot"
				buttonLabel="Chatbot"
				panelClassName="h-[520px] max-h-[70vh] w-[360px] max-w-[92vw]"
				bodyClassName="flex h-full flex-col"
			>
				<div className="flex h-full flex-col gap-3">
					<div className="flex-1 overflow-y-auto pr-1">
						<DemoContent />
					</div>
					<div className="rounded-xl border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
						Input area placeholder
					</div>
				</div>
			</ChatDock>
		);
	},
};

export const OpenByDefault: Story = {
	render: () => {
		const [open, setOpen] = useState(true);
		return (
			<ChatDock
				isOpen={open}
				onOpen={() => setOpen(true)}
				onClose={() => setOpen(false)}
				title="chatbot"
				buttonLabel="Chatbot"
				panelClassName="h-[520px] max-h-[70vh] w-[360px] max-w-[92vw]"
				bodyClassName="flex h-full flex-col"
			>
				<div className="flex h-full flex-col gap-3">
					<div className="flex-1 overflow-y-auto pr-1">
						<DemoContent />
					</div>
					<div className="rounded-xl border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
						Input area placeholder
					</div>
				</div>
			</ChatDock>
		);
	},
};
