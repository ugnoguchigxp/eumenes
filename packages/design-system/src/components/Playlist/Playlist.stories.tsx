import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Playlist } from "./Playlist";

const meta: Meta<typeof Playlist> = {
	title: "Components/Playlist",
	component: Playlist,
	tags: ["autodocs"],
};
export default meta;
type Story = StoryObj<typeof Playlist>;
export const Selectable: Story = {
	render: function Demo() {
		const [id, setId] = useState("one");
		return (
			<Playlist
				tracks={[
					{ id: "one", title: "Evening Current", durationSeconds: 222 },
					{ id: "two", title: "Soft Motion", durationSeconds: 178 },
				]}
				currentTrackId={id}
				onSelect={setId}
			/>
		);
	},
};
export const Empty: Story = { args: { tracks: [], onSelect: () => {} } };
