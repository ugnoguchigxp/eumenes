import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { LightSpiritLab, type LightSpiritLabMotion } from "./LightSpiritLab";

const motions: LightSpiritLabMotion[] = [
	{
		id: "listening",
		label: "聞く",
		group: "state",
		groupLabel: "状態",
		variants: [
			{ id: "listening-lean", label: "身を乗り出して包む" },
			{ id: "listening-tilt", label: "首をかしげて頷く" },
		],
	},
	{
		id: "joyful",
		label: "うれしい",
		group: "emotion",
		groupLabel: "感情と仕草",
		variants: [
			{ id: "joyful-spin", label: "跳ねて1回転" },
			{ id: "joyful-bounce", label: "腕を振り上げて弾む" },
		],
	},
	{
		id: "twirl",
		label: "くるっと回る",
		group: "idle-gesture",
		groupLabel: "待機中の仕草",
		variants: [{ id: "twirl", label: "くるっと1回転" }],
	},
];
/** The real stage is a WebGL canvas owned by the web host; stories show a placeholder. */
const stage = (
	<div style={{ display: "grid", placeItems: "center", color: "#ffdca2" }}>
		光の精霊
	</div>
);

function Interactive({ state }: { state: "ready" | "loading" | "failed" }) {
	const [selected, setSelected] = useState<string | null>("joyful");
	const [variant, setVariant] = useState("");
	const [playing, setPlaying] = useState(false);
	const [loop, setLoop] = useState(false);
	const [speed, setSpeed] = useState(1);
	const [speaking, setSpeaking] = useState(false);
	const [skeleton, setSkeleton] = useState(false);
	const [layers, setLayers] = useState({
		secondary: true,
		gaze: true,
		gestures: true,
	});
	return (
		<LightSpiritLab
			stage={stage}
			motions={motions}
			selected={selected}
			variant={variant}
			playing={playing}
			loop={loop}
			speed={speed}
			speaking={speaking}
			layers={layers}
			skeleton={skeleton}
			status={{
				state,
				motionLabel: "うれしい",
				variantLabel: "跳ねて1回転",
				elapsed: 1.8,
				fps: 24,
			}}
			onSelect={(id) => {
				setSelected(id);
				setVariant("");
				setPlaying(true);
			}}
			onVariant={setVariant}
			onPlay={() => setPlaying(true)}
			onStop={() => setPlaying(false)}
			onRestart={() => setPlaying(true)}
			onNeutral={() => {
				setSelected(null);
				setPlaying(false);
			}}
			onLoop={setLoop}
			onSpeed={setSpeed}
			onSpeaking={setSpeaking}
			onLayer={(layer, value) => setLayers((v) => ({ ...v, [layer]: value }))}
			onSkeleton={setSkeleton}
		/>
	);
}
const meta: Meta<typeof Interactive> = {
	title: "Components/LightSpiritLab",
	component: Interactive,
	tags: ["autodocs"],
};
export default meta;
type Story = StoryObj<typeof Interactive>;
export const Ready: Story = { args: { state: "ready" } };
export const Loading: Story = { args: { state: "loading" } };
export const Failed: Story = { args: { state: "failed" } };
