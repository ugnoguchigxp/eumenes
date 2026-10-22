import type { PipelineDefinition } from "../../capabilities";

/** A sound pipeline: research → extract → timer → music, with one fixture case. */
export const cookTimerMusic: PipelineDefinition = {
	formatVersion: 1,
	id: "cook-timer-music",
	title: "茹で時間を調べてタイマーと曲",
	summary:
		"食材の標準的な茹で時間を調べ、その時間のタイマーを掛け、待つ間の曲を作る",
	useWhen: ["パスタを茹でる時間を調べてタイマーを掛けて、曲も流して"],
	avoidWhen: [],
	inputs: {
		food: { type: "string", description: "茹でる食材", required: true },
		mood: {
			type: "string",
			description: "曲の雰囲気",
			required: false,
			default: "落ち着いた",
		},
	},
	steps: [
		{
			id: "research",
			kind: "toolchain",
			title: "調べる",
			toolchain: "web.search",
			request: "${inputs.food}の標準的な茹で時間を調べてください",
		},
		{
			id: "minutes",
			kind: "extract",
			title: "分を取り出す",
			from: ["${steps.research.summary}"],
			instruction: "標準的な茹で時間を分で。幅があれば短い方",
			schema: { type: "integer", minimum: 1, maximum: 120 },
		},
		{
			id: "timer",
			kind: "toolchain",
			title: "タイマー",
			toolchain: "timers.manage",
			request: "${steps.minutes.value}分のタイマーを掛けてください",
			require: ["output"],
		},
		{
			id: "music",
			kind: "toolchain",
			title: "曲",
			toolchain: "music.create",
			request: "${inputs.mood}な曲を作ってください",
		},
	],
	answer: "${inputs.food}は約${steps.minutes.value}分です。",
	tests: [
		{
			utterance: "ペンネを茹でる時間を調べてタイマーして、明るい曲も作って",
			inputs: { food: "ペンネ", mood: "明るい" },
			stepResults: {
				research: { summary: "ペンネの茹で時間は11〜12分が目安" },
				minutes: { value: 11 },
				timer: { output: { timerId: "t1" } },
				music: { summary: "作曲を受け付けました" },
			},
			expect: { "steps.minutes.value": 11 },
		},
	],
};
