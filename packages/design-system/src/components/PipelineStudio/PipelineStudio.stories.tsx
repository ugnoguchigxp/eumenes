import type { Meta, StoryObj } from "@storybook/react-vite";
import { PipelineStudio } from "./PipelineStudio";
import type { PipelineStudioWorkData } from "./types";

const source = `{
  "id": "weather-note",
  "inputs": {"city": {"type": "string", "description":"都市", "required": true}},
  "steps": [
    { "id": "search", "kind":"toolchain", "title":"天気を調べる", "toolchain": "web.search", "request": "\${inputs.city} の天気" },
    { "id": "pick", "title":"気温を取り出す", "kind": "extract", "from": "\${steps.search.summary}" }
  ],
  "answer": "\${steps.pick.value}"
}`;

const work: PipelineStudioWorkData = {
	workRef: "work-1",
	title: "天気のメモ",
	revision: 3,
	source,
	rejected: null,
	issues: [],
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
	tests: [
		{ index: 0, utterance: "東京の天気を教えて" },
		{ index: 1, utterance: "大阪の天気は" },
	],
	published: null,
	dirty: true,
	busy: false,
};

const noop = () => {};
const meta = {
	title: "Components/PipelineStudio",
	component: PipelineStudio,
	args: {
		work,
		history: [{ toolchainId: "pipeline.weather-note", title: "天気のメモ" }],
		onApply: noop,
		onPublish: noop,
		onProbe: noop,
		onSelect: noop,
		onFixture: noop,
		onOpen: noop,
		onRefresh: noop,
	},
	parameters: { layout: "padded" },
} satisfies Meta<typeof PipelineStudio>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Normal: Story = {};
export const Busy: Story = {
	args: {
		work: { ...work, busy: true },
		session: { state: "active", expiresAt: "2026-10-22T12:00:00.000Z" },
		stoppable: true,
		onStop: noop,
	},
};
export const Issues: Story = {
	args: {
		work: {
			...work,
			issues: [
				{ pointer: "/steps/1/uses", rule: "unknown_step_reference", line: 6 },
				{ pointer: "/answer", rule: "unknown_value", line: 8 },
			],
			rejected: {
				title: "壊れた案",
				text: '{ "id": 1 }',
				issues: [{ path: "/id", rule: "invalid_type" }],
				fixes: [],
			},
		},
	},
};
export const Published: Story = {
	args: {
		work: {
			...work,
			dirty: false,
			published: {
				toolchainRevisionId: "toolchain:pipeline.weather-note@1",
				functionName: "weather_note",
				revision: 2,
			},
		},
	},
};
export const ProbeResult: Story = {
	args: {
		trial: {
			kind: "probe",
			query: "東京の天気",
			pending: false,
			result: {
				ok: true,
				candidates: [
					{
						toolchainId: "web.search",
						title: "Web検索",
						functionName: "web_search",
						rank: 1,
						similarity: 0.71,
						ftsRank: 2,
						draft: false,
					},
					{
						toolchainId: "pipeline.weather-note",
						title: "天気のメモ",
						functionName: "weather_note",
						rank: 2,
						similarity: 0.66,
						ftsRank: null,
						draft: true,
					},
				],
				passages: [
					{ text: "都市の天気を調べて気温を答える", similarity: 0.66 },
				],
			},
		},
	},
};
export const SelectionResult: Story = {
	args: {
		trial: {
			kind: "select",
			utterance: "東京の天気を教えて",
			pending: false,
			result: {
				ok: true,
				chosen: "weather_note",
				matched: true,
				next: null,
				inputs: { city: "東京" },
				code: null,
			},
		},
	},
};
export const FixtureFailed: Story = {
	args: {
		trial: {
			kind: "fixture",
			test: 0,
			pending: false,
			result: {
				ok: true,
				outcome: {
					passed: false,
					steps: [{ id: "search", request: "東京 の天気" }, { id: "pick" }],
					answer: "晴れ",
					failures: [
						{
							path: "/answer",
							code: "mismatch",
							expected: "曇り",
							actual: "晴れ",
						},
					],
				},
			},
		},
	},
};
export const TrialRunning: Story = {
	args: {
		trial: { kind: "probe", query: "東京", pending: true, result: null },
	},
};
export const Loading: Story = { args: { loading: true, work: null } };
export const Empty: Story = { args: { work: null } };
export const Failed: Story = {
	args: { error: "パイプライン制作の情報を読み込めません。", work: null },
};
