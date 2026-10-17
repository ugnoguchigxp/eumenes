import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { StepGuide } from "./StepGuide";

const steps = [
	{ title: "基線ABを決める", body: "地上の2地点A・Bを選び、その距離を測る。" },
	{ title: "角度θを測る", body: "AとBから月を見たときの角度を測る。" },
	{ title: "距離を求める", body: "基線と角度から、月までの距離を計算する。" },
];

const meta = {
	title: "Components/StepGuide",
	component: StepGuide,
	parameters: { layout: "padded" },
	tags: ["autodocs"],
	decorators: [
		(Story) => (
			<div className="mx-auto max-w-[480px]">
				<Story />
			</div>
		),
	],
} satisfies Meta<typeof StepGuide>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 非制御: 部品の中で現在のステップを持つ。 */
export const Uncontrolled: Story = {
	args: { title: "三角測量の手順", steps },
};

/** 制御: 親が `step` を持つ。 */
export const Controlled: Story = {
	args: { steps },
	render: (args) => {
		const [step, setStep] = useState(1);
		return (
			<div className="flex flex-col gap-2">
				<StepGuide {...args} step={step} onStepChange={setStep} />
				<div className="text-xs text-muted-foreground">
					親が持つステップ: {step + 1}
				</div>
			</div>
		);
	},
};

export const TwelveSteps: Story = {
	args: {
		title: "12ステップ",
		steps: Array.from({ length: 12 }, (_, i) => ({
			title: `手順 ${i + 1}`,
			body: i % 2 === 0 ? `手順 ${i + 1} の説明。` : undefined,
		})),
	},
};

export const Dark: Story = {
	args: { title: "三角測量の手順", steps },
	decorators: [
		(Story) => (
			<div className="ds-theme-dark rounded-lg bg-background p-4">
				<Story />
			</div>
		),
	],
};
