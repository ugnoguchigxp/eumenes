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

function Interactive({
	state,
	message,
}: {
	state: "ready" | "loading" | "failed" | "unavailable";
	message?: string;
}) {
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
				message,
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
/** The web host drives the conversation background's spirit, so there is no own stage. */
export const Ready: Story = {
	args: { state: "ready", message: "会話の背景の精霊で再生しています。" },
};
export const Unavailable: Story = {
	args: {
		state: "unavailable",
		message: "会話の背景を「光の妖精」にすると、ここから精霊を動かせます。",
	},
};
export const Loading: Story = { args: { state: "loading" } };
export const Failed: Story = { args: { state: "failed" } };
