import type { DeliveryContext, Emotion } from "..";

/** Held-out examples: freeze expectations before the first live evaluation. */
export const validationCases: Array<{
	id: string;
	context: DeliveryContext;
	expected: Emotion;
}> = [
	{
		id: "v-name",
		expected: "warmth",
		context: {
			turns: [{ role: "user", text: "祖母が付けてくれた名前です。" }],
			answer: "すてきなお名前ですね。教えてくださってありがとうございます。",
		},
	},
	{
		id: "v-support-thanks",
		expected: "warmth",
		context: {
			turns: [{ role: "user", text: "昨日の相談、本当に助かった。" }],
			answer: "お役に立ててうれしいです。またいつでも話してくださいね。",
		},
	},
	{
		id: "v-celebration",
		expected: "joy",
		context: {
			turns: [{ role: "user", text: "ようやく原稿が完成しました！" }],
			answer: "完成おめでとうございます！長く取り組んできた成果ですね。",
		},
	},
	{
		id: "v-worried",
		expected: "empathy",
		context: {
			turns: [{ role: "user", text: "明日の発表が不安で、眠れません。" }],
			answer:
				"不安ですよね。今夜は無理をせず、一息ついてください。一緒に準備を整理しましょう。",
		},
	},
	{
		id: "v-loss",
		expected: "empathy",
		context: {
			turns: [{ role: "user", text: "友人を失って悲しいです。" }],
			answer: "悲しいですよね。すぐに元気になろうとしなくて大丈夫です。",
		},
	},
	{
		id: "v-invention",
		expected: "curiosity",
		context: {
			turns: [{ role: "user", text: "古い時計で新しい楽器を作っています。" }],
			answer:
				"面白そうですね。どんな仕組みなんですか？もう少し聞かせてください。",
		},
	},
	{
		id: "v-unexpected",
		expected: "surprise",
		context: {
			turns: [{ role: "user", text: "十五年ぶりに偶然再会しました。" }],
			answer: "なんと、十五年ぶりですか！それはびっくりしました。",
		},
	},
	{
		id: "v-technical",
		expected: "none",
		context: {
			turns: [
				{ role: "user", text: "合格してうれしい。ところでJSONの形式は？" },
			],
			answer:
				"JSONはキーと値の組を波括弧で囲みます。文字列にはダブルクォートを使います。",
		},
	},
	{
		id: "v-neutral-distress",
		expected: "none",
		context: {
			turns: [{ role: "user", text: "困っていて不安です。設定の場所は？" }],
			answer: "画面左下の設定を開いてください。音量は音声タブにあります。",
		},
	},
	{
		id: "v-factual-emotion",
		expected: "none",
		context: {
			turns: [{ role: "user", text: "親しみとはどういう意味？" }],
			answer: "親しみとは、人や物に対して近しさを感じることです。",
		},
	},
	{
		id: "v-quoted",
		expected: "none",
		context: {
			turns: [{ role: "user", text: "この文の表記を説明して。" }],
			answer:
				"「素敵ですね。ありがとう！」は二つの文です。句点と感嘆符が使われています。",
		},
	},
	{
		id: "v-negated",
		expected: "none",
		context: {
			turns: [{ role: "user", text: "文章を短くしてください。" }],
			answer: "うれしくない、という文に短縮できます。",
		},
	},
	{
		id: "v-code",
		expected: "none",
		context: {
			turns: [{ role: "user", text: "この変数の値は？" }],
			answer:
				"値は `素敵ですね、ありがとう` です。文字列として格納されています。",
		},
	},
	{
		id: "v-simple-question",
		expected: "none",
		context: {
			turns: [{ role: "user", text: "名前の由来を話したい。" }],
			answer: "あなたの名前についてでしょうか？",
		},
	},
];
