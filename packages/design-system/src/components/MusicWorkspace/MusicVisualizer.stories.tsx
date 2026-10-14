import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { MusicPlayer, type MusicPlaybackState } from "../MusicPlayer";
import { demoAudio } from "../MusicPlayer/demo.fixture";
import { MusicVisualizer } from "./MusicVisualizer";

const meta: Meta<typeof MusicVisualizer> = {
	title: "Components/MusicVisualizer",
	component: MusicVisualizer,
	tags: ["autodocs"],
};
export default meta;
type Story = StoryObj<typeof MusicVisualizer>;

function Demo() {
	const [src, setSrc] = useState("");
	const [mode, setMode] = useState<"spectrum" | "waveform">("spectrum");
	const [playback, setPlayback] = useState<MusicPlaybackState | null>(null);
	useEffect(() => {
		const url = URL.createObjectURL(demoAudio());
		setSrc(url);
		return () => URL.revokeObjectURL(url);
	}, []);
	return (
		<div style={{ display: "grid", gap: 16, maxWidth: 720 }}>
			<label>
				表示
				<select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
					<option value="spectrum">スペクトラム</option>
					<option value="waveform">波形</option>
				</select>
			</label>
			<div style={{ height: 240 }}>
				<MusicVisualizer
					analyser={playback?.analyser ?? null}
					playing={playback?.playing ?? false}
					active
					mode={mode}
				/>
			</div>
			<MusicPlayer
				track={src ? { id: "tone", title: "テスト音源", src } : null}
				onPlaybackChange={setPlayback}
			/>
		</div>
	);
}

export const WithAudio: Story = { render: () => <Demo /> };
