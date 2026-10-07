import type { Meta, StoryObj } from "@storybook/react-vite";

import { AsyncDataWrapper } from "./AsyncDataWrapper";

const meta: Meta<typeof AsyncDataWrapper> = {
	title: "Components/AsyncDataWrapper",
	component: AsyncDataWrapper,
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
type Story = StoryObj<typeof AsyncDataWrapper>;

export const Default: Story = {
	render: () => (
		<AsyncDataWrapper isLoading={false} isError={null} refetch={() => {}}>
			<div className="p-4 rounded border border-border bg-card text-foreground">
				Loaded content
			</div>
		</AsyncDataWrapper>
	),
};

export const Loading: Story = {
	render: () => (
		<AsyncDataWrapper isLoading={true} isError={null} refetch={() => {}}>
			<div />
		</AsyncDataWrapper>
	),
};
