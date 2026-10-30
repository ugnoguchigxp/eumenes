/**
 * The conversation harness measurement's chains of requests (the conversation harness design, section 5.1): what the
 * user says at each step, what a passing turn does, and the toolchain candidates a search returns, from the saved
 * toolchain cards. Pure data: nothing here calls a model or reads a database.
 */

/** What a step of a chain expects of the model's turn. */
export type Step = {
	say: string;
	/** A hand-over to this toolchain whose request matches `has` and not `not`. */
	expect?: { toolchain: string; has: RegExp; not?: RegExp };
	/** Any turn passes (the step only sets the talk up). */
	free?: boolean;
	/** The turn answers in words without a call and does not repeat the planted broken reply. */
	notBroken?: boolean;
	/** The turn repeats the agent's last reply without a call. */
	repeatOf?: boolean;
};
export type Planted = {
	role: "user" | "agent";
	text: string;
	/**
	 * For an agent entry that asked back: the request it asked about. A routed turn carries that as the question's
	 * `ask` step, so the user's answer is taken with the request (the reply loop never asks back).
	 */
	asked?: string;
};
export type Chain = {
	/** The name an argument selects it by. */
	key: string;
	name: string;
	steps: Step[];
	/** A hand-over ends with a host notice and the agent's report, as a finished work does. */
	reports: boolean;
	/** The talk before the first step. */
	planted?: Planted[];
};

const img = (has: RegExp, not?: RegExp) => ({
	toolchain: "image.create",
	has,
	...(not ? { not } : {}),
});
const snd = (has: RegExp, not?: RegExp) => ({
	toolchain: "music.create",
	has,
	...(not ? { not } : {}),
});
const CAT = /猫|ねこ|ネコ/;
const FROG = /カエル|蛙|かえる/;
/** A reply that said it had played something it could not have. */
const BROKEN_REPLY =
	"はい、ごめんなさい。先ほどの再生は記憶にない内容でした。\n\n火曜の夜にぴたりの音楽、新たに作る？";

export const CHAINS: readonly Chain[] = [
	{
		key: "sequence",
		name: "続けて頼む",
		reports: false,
		steps: [
			{ say: "猫の絵作って", expect: img(CAT) },
			{ say: "カエルの絵を作って", expect: img(FROG, CAT) },
			{ say: "雨音の効果音作って", expect: snd(/雨/, /猫|カエル|蛙/) },
			{ say: "ありがとう" },
			{ say: "富士山の画像を作って", expect: img(/富士/, /猫|カエル|雨/) },
		],
	},
	{
		key: "report",
		name: "報告・再生・指示語",
		reports: true,
		steps: [
			{ say: "元気が出る曲を作って", expect: snd(/元気/) },
			{ say: "再生して", expect: { toolchain: "music.library", has: /./ } },
			{
				say: "犬のイラストを描いて",
				expect: img(/犬|いぬ|イヌ/, /元気|曲/),
			},
			{ say: "同じ感じで猫も描いて", expect: img(CAT) },
			{ say: "ありがとう、助かったよ" },
		],
	},
	{
		key: "topic",
		name: "話の続き",
		reports: false,
		steps: [
			{ say: "私の好きな色は緑なんだ", free: true },
			{ say: "じゃあ好きな色で花の絵を描いて", expect: img(/緑|みどり/) },
			{ say: "ヤッターマンって知ってる？", free: true },
			{ say: "そのキャラクターの絵を描いて", expect: img(/ヤッターマン/) },
			{ say: "ありがとう" },
		],
	},
	{
		key: "reword",
		name: "言い直し",
		reports: false,
		steps: [
			{ say: "おすすめの映画を一つ教えて", free: true },
			{ say: "え？もう一回言って", repeatOf: true },
			{ say: "ありがとう" },
			{ say: "雨の日に合う曲を作って", expect: snd(/雨/) },
		],
	},
	{
		key: "promise",
		name: "約束だけの返事の後",
		reports: false,
		planted: [
			{ role: "user", text: "猫の絵作って" },
			{
				role: "agent",
				text: "猫の絵ですね。進めてまいります。少々お待ちください。",
			},
		],
		steps: [
			{ say: "まだかな", expect: img(CAT) },
			{ say: "カエルの絵を作って", expect: img(FROG, CAT) },
			{ say: "雨音の効果音作って", expect: snd(/雨/, /猫|カエル|蛙/) },
			{ say: "ありがとう" },
		],
	},
	{
		key: "broken",
		name: "壊れた返事の後",
		reports: false,
		planted: [
			{
				role: "user",
				text: "ごめんなあ、でもそれ、ハルシネーションなんだよ。",
			},
			{ role: "agent", text: BROKEN_REPLY },
		],
		steps: [
			{ say: "口調を直してほしいけどまあ", notBroken: true },
			{ say: "今日は何曜日？", notBroken: true },
			{ say: "最近どう？", notBroken: true },
			{ say: "猫の絵作って", expect: img(CAT) },
		],
	},
	{
		key: "answer-picture",
		name: "聞き返しへの答え（何の絵）",
		reports: false,
		planted: [
			{ role: "user", text: "絵を描いて" },
			{ role: "agent", text: "🙂何の絵にしましょうか？", asked: "絵を描いて" },
		],
		steps: [{ say: "猫で", expect: img(CAT) }, { say: "ありがとう" }],
	},
	{
		key: "answer-mood",
		name: "聞き返しへの答え（曲の雰囲気）",
		reports: false,
		planted: [
			{ role: "user", text: "曲を作って" },
			{
				role: "agent",
				text: "🙂どんな雰囲気の曲にしましょうか？",
				asked: "曲を作って",
			},
		],
		steps: [
			{ say: "明るい感じで", expect: snd(/明る/) },
			{ say: "ありがとう" },
		],
	},
	{
		key: "answer-offer",
		name: "提案への「うん」",
		reports: false,
		planted: [
			{ role: "user", text: "なんか気分が上がらないな" },
			{ role: "agent", text: "🙂元気が出る曲を作りましょうか？" },
		],
		steps: [
			{ say: "うん、お願い", expect: snd(/元気|明る|気分/) },
			{ say: "ありがとう" },
		],
	},
];

/** The first request alone, tried again and again from a clean start (`--probe`). */
export const PROBE_CHAIN: Chain = {
	key: "probe",
	name: "最初の依頼",
	reports: false,
	steps: [{ say: "猫の絵作って", expect: img(CAT) }],
};
export const PROBE_TRIES = 6;

/**
 * A step of the acceptance lane (the review intake plan, section 6.3): a step of the chains above, or one that checks
 * what the host did besides a hand-over. A seeded saved item is named by its title.
 */
export type AcceptStep = Step & {
	/** The turn issues a confirmation for this toolchain, its statement names the item, and nothing is handed over. */
	confirm?: { toolchain: string; target: string };
	/** The approval hands the item over to this toolchain. */
	approve?: { toolchain: string; target: string };
	/** The turn reads the chain's work `t<n>` and starts no new work. */
	check?: number;
	/** The turn cancels the chain's work `t<n>`. */
	cancel?: number;
	/** This instant toolchain answers: its inputs passed the host's check. */
	instant?: string;
};
export type AcceptChain = Omit<Chain, "steps"> & {
	steps: AcceptStep[];
	/** The saved items (by title) made before the first step, for the steps to name. */
	saved?: string[];
	/**
	 * Memory items the user asked to keep, each from a planted utterance (`said`), saved after the planted talk: what
	 * the turns' `## Memory` shows.
	 */
	remembered?: Array<{ said: string; key: string; text: string }>;
};

/**
 * The scenes the acceptance lane adds to the chains above (the review intake plan, section 6.3). A condition said
 * before (`topic`) and a request that must not take the earlier ones (`sequence`) are the chains above.
 */
export const ACCEPT_CHAINS: readonly AcceptChain[] = [
	{
		key: "accept-target",
		name: "対象を選んで直す → 承認",
		reports: false,
		saved: ["来場者アンケート"],
		steps: [
			{
				say: "保存してある来場者アンケートに、年代を聞く質問を足して",
				confirm: { toolchain: "ui.compose", target: "来場者アンケート" },
			},
			{
				say: "はい、お願いします",
				approve: { toolchain: "ui.compose", target: "来場者アンケート" },
			},
		],
	},
	{
		key: "accept-new",
		name: "新しく作る → 担当に切り替わる",
		reports: false,
		saved: ["来場者アンケート"],
		steps: [
			{
				say: "イヤホンのランディングページを作りたいです",
				expect: { toolchain: "ui.compose", has: /イヤホン|ランディング/ },
			},
		],
	},
	{
		key: "accept-running",
		name: "進行中の仕事を確かめる・取り消す",
		reports: false,
		steps: [
			{
				say: "最新のスマートフォンの売れ行きを調べて",
				expect: { toolchain: "web.search", has: /スマートフォン|スマホ/ },
			},
			{ say: "さっきの調べものはどうなった？", check: 1 },
			{ say: "やっぱりその調べものは取り消して", cancel: 1 },
		],
	},
	{
		key: "accept-done",
		name: "終わった仕事を確かめる",
		reports: false,
		steps: [
			{ say: "猫の絵を作って", expect: img(CAT) },
			{ say: "さっきの絵はどうなった？", check: 1 },
		],
	},
	{
		key: "accept-weather",
		name: "即答（天気）",
		reports: false,
		steps: [{ say: "明日の鎌倉の天気を教えて", instant: "weather.forecast" }],
	},
	{
		// The preference was said three utterances ago: past `## Earlier`, only `## Memory` holds it.
		key: "accept-memory",
		name: "記憶の好み",
		reports: false,
		planted: [
			{ role: "user", text: "好きな色は藍色です" },
			{ role: "agent", text: "承知しました。" },
			{ role: "user", text: "今日は暑いですね" },
			{ role: "agent", text: "そうですね。" },
			{ role: "user", text: "週末は出かける予定です" },
			{ role: "agent", text: "いいですね。" },
		],
		remembered: [
			{
				said: "好きな色は藍色です",
				key: "color.favorite",
				text: "好きな色は藍色",
			},
		],
		steps: [{ say: "好きな色で花の絵を描いて", expect: img(/藍/) }],
	},
];

/** A toolchain card as a search returns it (the fields of the product's candidate that the model reads). */
export type Card = {
	id: string;
	title: string;
	summary: string;
	useWhen: string[];
	execution?: string;
};

/** The toolchains whose work runs in the background (the search says so in `execution`). */
const BACKGROUND = new Set(["image.create", "music.create", "model3d.studio"]);
/** The ids each kind of request is answered with, in the order the search ranks them. */
const IMAGE = ["image.create", "model3d.studio", "excalidraw.edit"];
const SOUND = ["music.create", "music.library", "pipeline.studio"];
const OTHER = ["web.search", "image.create", "music.create"];
const PLAY = ["music.library", "music.create", "pipeline.studio"];
/** Every id a search can return: the cards the measurement needs from the saved definitions. */
export const CARD_IDS = [...new Set([...IMAGE, ...SOUND, ...OTHER, ...PLAY])];

/** The candidates a search with this query returns (a fixed routing by words, not the product's retrieval). */
export function candidatesFor(
	cards: Readonly<Record<string, Card>>,
	query: string,
): Card[] {
	const ids = /再生|聞/.test(query)
		? PLAY
		: /効果音|音楽|曲|BGM|歌|音/.test(query)
			? SOUND
			: /絵|画像|イラスト|写真|描/.test(query)
				? IMAGE
				: OTHER;
	return ids.map((id) => {
		const card = cards[id];
		if (!card) throw new Error(`harness_card_missing:${id}`);
		return BACKGROUND.has(id) ? { ...card, execution: "background" } : card;
	});
}
