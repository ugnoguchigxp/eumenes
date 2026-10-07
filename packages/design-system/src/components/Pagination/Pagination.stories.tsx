import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { Pagination } from "./Pagination";

const meta: Meta<typeof Pagination> = {
	title: "Components/Pagination",
	component: Pagination,
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
type Story = StoryObj<typeof Pagination>;

export const Default: Story = {
	render: () => {
		const [page, setPage] = useState(2);
		const totalPages = 5;
		return (
			<Pagination
				currentPage={page}
				totalPages={totalPages}
				onPrevPage={() => setPage((p) => Math.max(1, p - 1))}
				onNextPage={() => setPage((p) => Math.min(totalPages, p + 1))}
			/>
		);
	},
};
