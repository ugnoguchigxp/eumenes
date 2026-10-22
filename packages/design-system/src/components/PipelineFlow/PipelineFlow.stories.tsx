import type { Meta, StoryObj } from "@storybook/react-vite";
import { PipelineFlow } from "./PipelineFlow";

const meta = {
	title: "Components/PipelineFlow",
	component: PipelineFlow,
	args: {
		flow: {
			inputs: [{ name: "city", type: "string", required: true }],
			steps: [
				{
					id: "search",
					kind: "toolchain",
					title: "天気を調べる",
					toolchain: "web.search",
					reads: [],
					inputs: ["city"],
				},
				{
					id: "pick",
					kind: "extract",
					title: "気温を取り出す",
					toolchain: null,
					reads: ["search"],
					inputs: [],
				},
			],
			answer: { inputs: [], reads: ["pick"] },
		},
	},
} satisfies Meta<typeof PipelineFlow>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Normal: Story = {};
export const WithIssues: Story = {
	args: {
		issues: [
			{ pointer: "/steps/1/uses", rule: "unknown_step_reference", line: 6 },
		],
	},
};
export const Empty: Story = { args: { flow: null } };
