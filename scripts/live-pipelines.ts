import type { PipelineDefinition } from "../api/domains/capabilities";

/**
 * Hand-written task pipelines for live acceptance (spec task-pipeline-design 2026-10-22 §9, Q7). The live runner
 * publishes them into its isolated database with `--pipelines`; nothing here is seeded into a product database.
 */
export const livePipelines: PipelineDefinition[] = [
	{
		formatVersion: 1,
		id: "cook-timer-music",
		title: "茹で時間を調べてタイマーと曲",
		summary:
			"食材の標準的な茹で時間をWebで調べ、その時間のタイマーをセットし、待つ間に流す曲を1曲作る",
		useWhen: [
			"パスタなど食材の茹で時間を調べて、その時間でタイマーをセットし、待つ間の曲も作ってほしい",
			"茹で時間を確認してタイマーを掛け、BGMも作ってほしい",
		],
		avoidWhen: [
			"時間が決まっているタイマーだけの依頼",
			"茹で時間を知りたいだけの依頼",
		],
		inputs: {
			food: { type: "string", description: "茹でる食材", required: true },
			mood: {
				type: "string",
				description: "曲の雰囲気（明るい、落ち着いた など）",
				required: false,
				default: "明るい",
			},
		},
		steps: [
			{
				id: "research",
				kind: "toolchain",
				title: "茹で時間を調べる",
				toolchain: "web.search",
				request:
					"${inputs.food}の標準的な茹で時間を調べてください。何分かを答えてください。",
			},
			{
				id: "minutes",
				kind: "extract",
				title: "分を取り出す",
				from: ["${steps.research.summary}"],
				instruction:
					"標準的な茹で時間を分の整数で。幅があるときは短い方。秒の端数は切り捨てる",
				schema: { type: "integer", minimum: 1, maximum: 60 },
			},
			{
				id: "timer",
				kind: "toolchain",
				title: "タイマー",
				toolchain: "timers.manage",
				request: "${steps.minutes.value}分のタイマーをセットしてください",
			},
			{
				id: "music",
				kind: "toolchain",
				title: "曲",
				toolchain: "music.create",
				request: "${inputs.mood}雰囲気の曲を1曲作ってください",
			},
		],
		answer:
			"${inputs.food}の茹で時間は約${steps.minutes.value}分です。${steps.minutes.value}分のタイマーをセットし、曲を作りました。",
		tests: [
			{
				utterance:
					"そばの茹で時間を調べてタイマーをセットして、待つ間に落ち着いた曲も作って",
				inputs: { food: "そば", mood: "落ち着いた" },
				stepResults: {
					research: { summary: "そばの茹で時間は4〜5分が目安です" },
					minutes: { value: 4 },
					timer: { summary: "4分のタイマーを開始しました" },
					music: { summary: "作曲しました" },
				},
				expect: { "steps.minutes.value": 4 },
			},
		],
	},
	{
		formatVersion: 1,
		id: "image-model-music",
		title: "画像から3Dモデルと曲",
		summary:
			"指定の対象の画像を1枚作り、その画像から3Dモデルを作り、作業用BGMとして曲を1曲作る",
		useWhen: [
			"画像を作って、その画像をもとに3Dモデルを作り、BGMの曲も作ってほしい",
			"キャラクターの画像から3Dモデルを作って、作業用の曲も頼みたい",
		],
		avoidWhen: ["画像だけ、3Dモデルだけ、曲だけの依頼"],
		inputs: {
			subject: {
				type: "string",
				description: "画像にする対象（猫のマスコット など）",
				required: true,
			},
			mood: {
				type: "string",
				description: "曲の雰囲気（明るい、にぎやか など）",
				required: false,
				default: "明るい",
			},
		},
		steps: [
			{
				id: "image",
				kind: "toolchain",
				title: "画像",
				toolchain: "image.create",
				request: "${inputs.subject}の画像を1枚作ってください",
				require: ["output.artifactId"],
			},
			{
				id: "model",
				kind: "toolchain",
				title: "3Dモデル",
				toolchain: "model3d.studio",
				request:
					"画像（sourceImageRef: ${steps.image.output.artifactId}）をもとに、${inputs.subject}の3Dモデルを作ってください",
			},
			{
				id: "music",
				kind: "toolchain",
				title: "曲",
				toolchain: "music.create",
				request: "作業用BGMとして${inputs.mood}雰囲気の曲を1曲作ってください",
			},
		],
		answer:
			"${inputs.subject}の画像を作り、その画像から3Dモデルを作って、曲も作りました。",
		tests: [
			{
				utterance:
					"うさぎのキャラクターの画像を作って、それを3Dモデルにして、にぎやかなBGMも作って",
				inputs: { subject: "うさぎのキャラクター", mood: "にぎやか" },
				stepResults: {
					image: { output: { artifactId: "img_1" } },
					model: { summary: "3Dモデルの生成を受け付けました" },
					music: { summary: "作曲しました" },
				},
				expect: { "steps.image.output.artifactId": "img_1" },
			},
		],
	},
];
