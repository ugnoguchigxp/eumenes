import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "@/components/Button";

import { Modal, ModalFooter } from "./Modal";

const meta: Meta<typeof Modal> = {
	title: "Components/Modal",
	component: Modal,
	tags: ["autodocs"],
	decorators: [
		(Story) => (
			<>
				<div
					style={{
						padding: "2rem",
						backgroundColor: "hsl(var(--background))",
						height: "400px",
					}}
				>
					<Story />
				</div>
			</>
		),
	],
};

export default meta;
type Story = StoryObj<typeof Modal>;

const scrollableLines = Array.from({ length: 20 }, (_, index) => ({
	id: `line-${index + 1}`,
	label: `Line ${index + 1}: This content is long enough to scroll.`,
}));

export const Default: Story = {
	render: () => (
		<Modal
			trigger={<Button>Open Modal</Button>}
			title="Default Modal"
			description="This is a default modal with a title and description."
		>
			<div className="text-foreground">
				<p>This is the content of the modal.</p>
				<p>It is draggable by default.</p>
			</div>
		</Modal>
	),
};

export const NotDraggable: Story = {
	render: () => (
		<Modal
			trigger={<Button>Open Non-Draggable Modal</Button>}
			title="Non-Draggable Modal"
			draggable={false}
		>
			<div className="text-foreground">
				<p>This modal cannot be dragged.</p>
			</div>
		</Modal>
	),
};

export const WithFooter: Story = {
	render: () => (
		<Modal
			trigger={<Button>Open Modal with Footer</Button>}
			title="Modal with Footer"
			footer={
				<ModalFooter>
					<Button variant="secondary">Cancel</Button>
					<Button>Confirm</Button>
				</ModalFooter>
			}
		>
			<div className="text-foreground">
				<p>This modal has a footer with actions.</p>
			</div>
		</Modal>
	),
};

export const NoHeader: Story = {
	render: () => (
		<Modal trigger={<Button>Open No-Header Modal</Button>} noHeader>
			<div className="text-foreground p-4">
				<p>This modal has no header.</p>
				<p>Useful for custom layouts.</p>
			</div>
		</Modal>
	),
};

export const NoPadding: Story = {
	render: () => (
		<Modal
			trigger={<Button>Open No-Padding Modal</Button>}
			title="No Padding Modal"
			noPadding
		>
			<div className="bg-red-100 p-4 text-red-900 w-full h-full">
				<p>Content spans the entire width/height.</p>
				<p>Background color shows full coverage.</p>
			</div>
		</Modal>
	),
};

export const Scrollable: Story = {
	render: () => (
		<Modal
			trigger={<Button>Open Scrollable Modal</Button>}
			title="Scrollable Content"
			description="Scroll down to see more."
			draggable={false}
		>
			<div className="text-foreground space-y-4">
				{scrollableLines.map((line) => (
					<p key={line.id}>{line.label}</p>
				))}
			</div>
		</Modal>
	),
};

export const AllVariants: Story = {
	render: () => (
		<div className="flex gap-4 flex-wrap">
			<Modal trigger={<Button>Default</Button>} title="Default">
				<div className="text-foreground">Default</div>
			</Modal>
			<Modal
				trigger={<Button variant="secondary">No Drag</Button>}
				title="No Drag"
				draggable={false}
			>
				<div className="text-foreground">Not Draggable</div>
			</Modal>
			<Modal
				trigger={<Button variant="secondary">Footer</Button>}
				title="With Footer"
				footer={<Button size="sm">Action</Button>}
			>
				<div className="text-foreground">With Footer</div>
			</Modal>
			<Modal trigger={<Button variant="outline">No Header</Button>} noHeader>
				<div className="text-foreground p-4">No Header</div>
			</Modal>
		</div>
	),
};
