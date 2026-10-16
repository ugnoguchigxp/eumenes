import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { Playlist } from "../Playlist";
import { demoAudio } from "./demo.fixture";
import { MusicPlayer } from "./MusicPlayer";

const meta: Meta<typeof MusicPlayer> = {
	title: "Components/MusicPlayer",
	component: MusicPlayer,
	tags: ["autodocs"],
};
export default meta;
type Story = StoryObj<typeof MusicPlayer>;
export function PlayerAndPlaylistDemo() {
	const [src, setSrc] = useState("");
	const [index, setIndex] = useState(0);
	useEffect(() => {
		const url = URL.createObjectURL(demoAudio());
		// oxlint-disable-next-line react/set-state-in-effect -- local state follows a prop or open state, reset when it changes
		setSrc(url);
		return () => URL.revokeObjectURL(url);
	}, []);
	const tracks = [
		"Evening Current",
		"Soft Motion",
		"Quiet Orbit",
		"Morning Light",
	].map((title, i) => ({
		id: String(i),
		title,
		subtitle: "デモ音源 · テストトーン",
		durationSeconds: 30,
		src,
	}));
	return (
		<div
			style={{
				display: "grid",
				gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
				gap: 24,
				padding: 24,
				maxWidth: 1000,
			}}
		>
			<MusicPlayer
				track={src ? (tracks[index] ?? null) : null}
				onPrevious={index > 0 ? () => setIndex(index - 1) : undefined}
				onNext={
					index < tracks.length - 1 ? () => setIndex(index + 1) : undefined
				}
			/>
			<Playlist
				tracks={tracks}
				currentTrackId={String(index)}
				onSelect={(id) => setIndex(Number(id))}
			/>
		</div>
	);
}
export const WithPlaylist: Story = { render: () => <PlayerAndPlaylistDemo /> };
export const Empty: Story = { args: { track: null } };
export const Narrow: Story = {
	render: () => (
		<div style={{ width: 320 }}>
			<PlayerAndPlaylistDemo />
		</div>
	),
};
