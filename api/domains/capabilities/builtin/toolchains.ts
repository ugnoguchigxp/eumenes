import type { Definition } from "../contracts";

/**
 * Toolchains: one fixed set of sub-agent (profile), SKILL, tools and artifact, offered to the
 * conversation model as one function that takes only `{ request }`. The package carries the
 * profile, SKILL and tool details; the toolchain adds how the conversation finds and calls it.
 */
const base = { revision: 1, aliases: [], tags: [] };
export const toolchainBuiltins: Definition[] = [
	{
		...base,
		kind: "toolchain",
		id: "web.search",
		functionName: "web_search",
		title: "Web検索",
		summary:
			"天気・一銘柄の株価・言葉の定義・地名・人物・指定URLの一項目など、一つの公開情報を調べて出典付きで返す",
		useWhen: [
			"現在の天気や予報を知りたい",
			"株価や為替など一つの数値を知りたい",
			"言葉の意味・地名・人物・組織を確認したい",
			"指定URLのページの内容を確認したい",
		],
		avoidWhen: ["ニュースの整理", "複数資料の比較"],
		redirects: [
			{
				when: "ニュースや話題を集めて整理する、複数資料を比べる",
				toolchainId: "web.research.luna",
			},
		],
		examples: [
			"鎌倉の天気を教えて",
			"明日の東京の天気は？",
			"トヨタの株価はいくら？",
			"WBSってなんだっけ",
			"このURLの営業時間を確認して",
			"今のドル円は？",
		],
		dependencies: ["package:web.recipe@1"],
		packageRevisionId: "package:web.recipe@1",
		artifact: { kind: "component", component: "ResearchTaskCard" },
	},
	{
		...base,
		kind: "toolchain",
		id: "web.research.luna",
		functionName: "web_research",
		title: "Web調査",
		summary:
			"ニュースや一般的なWeb検索、複数資料の整理を行い、見つかった情報と出典を返す",
		useWhen: [
			"今日のニュースや話題を知りたい",
			"ある話題について詳しく調べてほしい",
			"複数の資料を比べて整理してほしい",
		],
		avoidWhen: ["一つの事実の確認"],
		redirects: [
			{
				when: "天気・株価・言葉の定義など一つの事実の確認",
				toolchainId: "web.search",
			},
		],
		examples: [
			"今朝のニュースを教えて",
			"DeepSeek harnessってなに？詳しく教えて",
			"最近のAI関連のニュースをまとめて",
			"EVの補助金制度を比較して",
		],
		dependencies: ["package:web.search@1"],
		packageRevisionId: "package:web.search@1",
		artifact: { kind: "component", component: "ResearchTaskCard" },
	},
	{
		...base,
		kind: "toolchain",
		id: "history.research",
		functionName: "conversation_history",
		title: "会話履歴の確認",
		summary: "これまでの会話で誰が何を言ったかを保存済みの発言から確認する",
		useWhen: [
			"以前の会話の内容を思い出したい",
			"自分や相手が前に言ったことを確認したい",
		],
		avoidWhen: ["Webの公開情報の確認"],
		redirects: [{ when: "公開情報の確認", toolchainId: "web.search" }],
		examples: [
			"さっき何て言った？",
			"前に話した旅行の予定を確認して",
			"昨日おすすめしてくれた本は何だっけ",
		],
		dependencies: ["package:history.research@2"],
		packageRevisionId: "package:history.research@2",
		artifact: { kind: "component", component: "ResearchTaskCard" },
	},
	{
		...base,
		kind: "toolchain",
		id: "timers.manage",
		functionName: "timer",
		title: "タイマー",
		summary: "相対時間のタイマーを開始・確認・取消する",
		useWhen: [
			"何分後に知らせてほしい",
			"タイマーの残り時間を知りたい",
			"タイマーを止めたい",
		],
		avoidWhen: ["時刻指定の予定", "繰り返しのアラーム"],
		redirects: [],
		examples: [
			"3分のタイマーをセットして",
			"タイマーあと何分？",
			"パスタのタイマーを止めて",
		],
		dependencies: ["package:timers.manage@1"],
		packageRevisionId: "package:timers.manage@1",
		artifact: { kind: "component", component: "TimerArtifact" },
	},
	{
		...base,
		kind: "toolchain",
		id: "music.create",
		functionName: "music",
		title: "作曲",
		summary:
			"テーマや長さを指定して新しい曲を作り、プレイヤーで再生できるようにする",
		useWhen: ["新しい曲や歌を作ってほしい"],
		avoidWhen: ["保存済みの曲を聴く"],
		redirects: [
			{ when: "保存済みの曲を探して聴く", toolchainId: "music.library" },
		],
		examples: [
			"雨の日のピアノ曲を作って",
			"30秒の明るいBGMを作曲して",
			"猫の歌を作って",
		],
		dependencies: ["package:music.create@2"],
		packageRevisionId: "package:music.create@2",
		artifact: { kind: "component", component: "MusicArtifact" },
	},
	{
		...base,
		kind: "toolchain",
		id: "music.library",
		functionName: "music_library",
		title: "音楽ライブラリ",
		summary: "保存済みの曲を探し、プレイリストとプレイヤーを開く",
		useWhen: ["保存済みの曲を聴きたい", "お気に入りやライブラリを開きたい"],
		avoidWhen: ["新しい曲を作る"],
		redirects: [{ when: "新しい曲を作る", toolchainId: "music.create" }],
		examples: [
			"お気に入りの曲を流して",
			"前に作った曲を聴かせて",
			"音楽ライブラリを開いて",
		],
		dependencies: ["package:music.playback@1"],
		packageRevisionId: "package:music.playback@1",
		artifact: { kind: "component", component: "LibraryArtifact" },
	},
	{
		...base,
		kind: "toolchain",
		id: "dots.delegate",
		functionName: "delegate_project",
		title: "プロジェクトへの委任",
		summary:
			"登録済みのCodexプロジェクトへ実装・レビュー・広い調査・コンテンツ作業を委任し、状況照会・質問への回答・停止を行う",
		useWhen: [
			"プロジェクトの実装やレビューを任せたい",
			"委任した作業の状況を知りたい",
			"委任先の質問に答えたい、作業を止めたい",
		],
		avoidWhen: ["その場で答えられる質問", "短いWeb検索"],
		redirects: [{ when: "短いWeb検索", toolchainId: "web.search" }],
		examples: [
			"eumenesのログ画面を実装して",
			"さっき頼んだ作業はどうなった？",
			"委任した作業を止めて",
		],
		dependencies: ["package:dots.orchestrate@2"],
		packageRevisionId: "package:dots.orchestrate@2",
		artifact: { kind: "component", component: "DotsPanel" },
	},
];
