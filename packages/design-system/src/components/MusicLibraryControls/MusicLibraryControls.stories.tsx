import type { Meta, StoryObj } from "@storybook/react-vite";
import { MusicLibraryControls } from "./MusicLibraryControls";
const meta: Meta<typeof MusicLibraryControls> = {
	title: "Components/MusicLibraryControls",
	component: MusicLibraryControls,
	tags: ["autodocs"],
};
export default meta;
type Story = StoryObj<typeof MusicLibraryControls>;
export const Library: Story = {
	args: {
		filter: { q: "", tags: [], sort: "createdAt", order: "desc" },
		tags: [
			{ tag: "明るい", count: 5 },
			{ tag: "ピアノ", count: 3 },
		],
		total: 12,
		hasMore: true,
		onSearch: () => {},
		onMore: () => {},
		onRefresh: () => {},
	},
};
export const Loading: Story = { args: { ...Library.args, loading: true } };
export const Failed: Story = {
	args: { ...Library.args, error: "楽曲を取得できませんでした。" },
};
