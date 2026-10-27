import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { StepGuide } from "../StepGuide/StepGuide";
import { Diagram, type DiagramElement } from "./Diagram";

const meta = {
	title: "Components/Diagram",
	component: Diagram,
	parameters: { layout: "padded" },
	tags: ["autodocs"],
	decorators: [
		(Story) => (
			<div className="mx-auto max-w-[640px]">
				<Story />
			</div>
		),
	],
} satisfies Meta<typeof Diagram>;

export default meta;
type Story = StoryObj<typeof meta>;

type ForceOptions = {
	/** 迎角（度）。機体の向きと角度の弧に使う。 */
	attack: number;
	/** 揚力の矢印の長さ。 */
	lift: number;
	highlight?: "lift" | "weight" | "thrust" | "drag" | "attack";
};

/** 飛行機に働く4つの力。値はここで評価済みにして Diagram へ渡す。 */
const airplaneForces = ({
	attack,
	lift,
	highlight,
}: ForceOptions): DiagramElement[] => {
	const cx = 50;
	const cy = 28;
	const nose = [
		cx + 24 * Math.cos((attack * Math.PI) / 180),
		cy - 24 * Math.sin((attack * Math.PI) / 180),
	] as const;
	return [
		{
			type: "shape",
			shape: "ellipse",
			x: cx - 20,
			y: cy - 3,
			w: 40,
			h: 6,
			rotate: attack,
			color: "muted",
			filled: true,
		},
		{
			type: "polygon",
			points: [
				[cx - 6, cy],
				[cx + 6, cy],
				[cx - 4, cy - 10],
				[cx - 10, cy - 10],
			],
			rotate: attack,
			origin: [cx, cy],
			color: "muted",
			filled: true,
		},
		{
			type: "line",
			x1: cx,
			y1: cy,
			x2: nose[0],
			y2: nose[1],
			dashed: true,
			color: "muted",
		},
		{
			type: "angle",
			x: cx,
			y: cy,
			from: 0,
			to: attack,
			radius: 15,
			label: "迎角 α",
			color: "accent",
			highlighted: highlight === "attack",
		},
		{
			type: "arrow",
			x1: cx,
			y1: cy,
			x2: cx,
			y2: cy - lift,
			label: "揚力",
			color: "positive",
			highlighted: highlight === "lift",
		},
		{
			type: "arrow",
			x1: cx,
			y1: cy,
			x2: cx,
			y2: cy + 18,
			label: "重力",
			color: "negative",
			highlighted: highlight === "weight",
		},
		{
			type: "arrow",
			x1: cx,
			y1: cy,
			x2: cx + 34,
			y2: cy,
			label: "推力",
			color: "accent",
			highlighted: highlight === "thrust",
		},
		{
			type: "arrow",
			x1: cx,
			y1: cy,
			x2: cx - 28,
			y2: cy,
			label: "抗力",
			color: "warning",
			highlighted: highlight === "drag",
		},
	];
};

export const AirplaneForces: Story = {
	args: {
		title: "飛行機に働く4つの力",
		caption: "揚力・重力・推力・抗力がつり合うと、飛行機は一定の高さで進む。",
		elements: airplaneForces({ attack: 8, lift: 20 }),
	},
};

/** 三角測量: 基線ABの両端から月を見たときの視線と角度θ。 */
const triangulation = (
	showMeasure: boolean,
	showResult: boolean,
): DiagramElement[] => {
	const a = [18, 44] as const;
	const b = [70, 44] as const;
	const moon = [58, 10] as const;
	return [
		{
			type: "line",
			x1: a[0],
			y1: a[1],
			x2: b[0],
			y2: b[1],
			label: "基線 AB",
			color: "ink",
		},
		{
			type: "shape",
			shape: "ellipse",
			x: moon[0] - 4,
			y: moon[1] - 4,
			w: 8,
			h: 8,
			filled: true,
			color: "warning",
		},
		{
			type: "label",
			x: moon[0] + 6,
			y: moon[1],
			text: "月",
			align: "start",
			size: "lg",
			color: "warning",
		},
		{ type: "label", x: a[0], y: a[1] + 5, text: "A" },
		{ type: "label", x: b[0], y: b[1] + 5, text: "B" },
		{
			type: "line",
			x1: a[0],
			y1: a[1],
			x2: moon[0],
			y2: moon[1],
			dashed: true,
			color: "accent",
			visible: showMeasure,
			highlighted: showMeasure && !showResult,
		},
		{
			type: "line",
			x1: b[0],
			y1: b[1],
			x2: moon[0],
			y2: moon[1],
			dashed: true,
			color: "accent",
			visible: showMeasure,
			highlighted: showMeasure && !showResult,
		},
		{
			type: "angle",
			x: a[0],
			y: a[1],
			from: 0,
			to: 71.6,
			radius: 10,
			label: "θ",
			color: "positive",
			visible: showMeasure,
		},
		{
			type: "arrow",
			x1: 82,
			y1: 44,
			x2: 82,
			y2: 12,
			label: "距離 d",
			color: "negative",
			visible: showResult,
		},
	];
};

export const Triangulation: Story = {
	args: {
		title: "三角測量で月までの距離を求める",
		caption:
			"基線の長さと、両端から月を見た角度θがわかれば、月までの距離が決まる。",
		elements: triangulation(true, true),
	},
};

export const Wide: Story = {
	args: {
		aspect: "wide",
		title: "ばねの伸び",
		elements: [
			{
				type: "shape",
				shape: "rect",
				x: 4,
				y: 10,
				w: 6,
				h: 22,
				filled: true,
				color: "muted",
			},
			{
				type: "polyline",
				points: [
					[10, 21],
					[20, 21],
					[24, 12],
					[32, 30],
					[40, 12],
					[48, 30],
					[56, 12],
					[64, 30],
					[68, 21],
					[76, 21],
				],
				color: "ink",
			},
			{
				type: "shape",
				shape: "rect",
				x: 76,
				y: 14,
				w: 14,
				h: 14,
				filled: true,
				color: "accent",
				label: "おもり",
			},
			{ type: "arrow", x1: 90, y1: 21, x2: 98, y2: 21, color: "positive" },
		],
	},
};

export const Square: Story = {
	args: {
		aspect: "square",
		title: "直角三角形",
		elements: [
			{
				type: "polygon",
				points: [
					[15, 80],
					[80, 80],
					[80, 20],
				],
				filled: true,
				color: "accent",
			},
			{
				type: "angle",
				x: 80,
				y: 80,
				from: 90,
				to: 180,
				radius: 12,
				color: "ink",
			},
			{
				type: "angle",
				x: 15,
				y: 80,
				from: 0,
				to: 43,
				radius: 18,
				label: "θ",
				color: "positive",
			},
			{ type: "label", x: 47, y: 86, text: "底辺 a", size: "md" },
			{ type: "label", x: 84, y: 50, text: "高さ b", align: "start" },
			{
				type: "label",
				x: 42,
				y: 46,
				text: "斜辺 c",
				align: "end",
				color: "muted",
			},
		],
	},
};

export const Dark: Story = {
	args: AirplaneForces.args,
	decorators: [
		(Story) => (
			<div className="ds-theme-dark rounded-lg bg-background p-4">
				<Story />
			</div>
		),
	],
};

export const DarkTriangulation: Story = {
	args: Triangulation.args,
	decorators: Dark.decorators,
};

const TRIANGULATION_STEPS = [
	{
		title: "基線ABを決める",
		body: "地上の2地点A・Bを選び、その距離（基線）を測る。",
	},
	{
		title: "月への視線を引く",
		body: "AとBそれぞれから、月へ向かう視線を引く。",
	},
	{ title: "角度θを測る", body: "基線と視線がつくる角度θを、AとBで測る。" },
	{
		title: "距離dを求める",
		body: "基線とθから三角形を決め、月までの距離dを求める。",
	},
];

/** ステップ解説と連動して図を出す例。 */
export const WithStepGuide: Story = {
	args: { elements: [] },
	render: () => {
		const [step, setStep] = useState(0);
		const elements = triangulation(step >= 1, step >= 3).map((el) => {
			if (el.type === "angle") return { ...el, visible: step >= 2 };
			return el;
		});
		return (
			<div className="flex flex-col gap-3">
				<Diagram title="三角測量で月までの距離を求める" elements={elements} />
				<StepGuide
					steps={TRIANGULATION_STEPS}
					step={step}
					onStepChange={setStep}
				/>
			</div>
		);
	},
};

export const AirplaneWithHighlights: Story = {
	args: { elements: [] },
	render: () => {
		const [step, setStep] = useState(0);
		const order = ["lift", "weight", "thrust", "drag", "attack"] as const;
		return (
			<div className="flex flex-col gap-3">
				<Diagram
					title="飛行機に働く4つの力"
					elements={airplaneForces({
						attack: 8,
						lift: 20,
						highlight: order[step],
					})}
				/>
				<StepGuide
					step={step}
					onStepChange={setStep}
					steps={[
						{
							title: "揚力",
							body: "翼が空気を押し下げる反作用で、機体が上へ押される。",
						},
						{ title: "重力", body: "機体の重さ。常に真下へ働く。" },
						{ title: "推力", body: "エンジンが機体を前へ進める力。" },
						{ title: "抗力", body: "空気が機体の進みを妨げる力。" },
						{
							title: "迎角",
							body: "進行方向と翼の向きのなす角。大きいほど揚力が増える（上限あり）。",
						},
					]}
				/>
			</div>
		);
	},
};
