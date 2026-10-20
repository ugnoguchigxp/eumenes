/** Display choices, not rules for interpreting a user's musical intent. */
export const musicGenres = [
	{
		label: "ポップ・ロック",
		options: [
			"ポップ",
			"J-pop",
			"K-pop",
			"ロック",
			"インディー",
			"オルタナティブ",
			"パンク",
			"メタル",
			"ファンク",
			"ディスコ",
			"シティポップ",
			"バラード",
		],
	},
	{
		label: "エレクトロニック",
		options: [
			"Lo-fi",
			"Ambient",
			"House",
			"Techno",
			"EDM",
			"Synthwave",
			"Drum & Bass",
			"Chiptune",
			"Trance",
			"Dubstep",
			"Downtempo",
			"エレクトロポップ",
		],
	},
	{
		label: "ジャズ・アコースティック",
		options: [
			"ジャズ",
			"ボサノバ",
			"R&B",
			"ソウル",
			"アコースティック",
			"フォーク",
			"ブルース",
			"ゴスペル",
			"スウィング",
			"フュージョン",
			"カントリー",
			"ブルーグラス",
		],
	},
	{
		label: "クラシック・映像",
		options: [
			"クラシック",
			"オーケストラ",
			"シネマティック",
			"ゲーム音楽",
			"室内楽",
			"ピアノソロ",
			"ミニマル",
			"ワルツ",
			"バロック",
			"オペラ",
			"ミュージカル",
			"ニューエイジ",
		],
	},
	{
		label: "ヒップホップ・世界の音楽",
		options: [
			"ヒップホップ",
			"トラップ",
			"ラップ",
			"レゲエ",
			"ダブ",
			"ラテン",
			"サンバ",
			"タンゴ",
			"フラメンコ",
			"ケルト",
			"和風",
			"アフロビート",
		],
	},
] as const;
export const musicMoods = [
	"落ち着いた",
	"温かい",
	"明るい",
	"切ない",
	"幻想的",
	"力強い",
	"壮大",
	"緊張感",
	"軽快",
	"ダーク",
];
export const musicInstruments = [
	"ピアノ",
	"シンセ",
	"ギター",
	"ストリングス",
	"ドラム",
	"ベース",
	"ブラス",
	"木管",
	"ハープ",
	"打楽器",
];
export const musicVoiceQualities = [
	"透明感",
	"柔らかい",
	"温かい",
	"ハスキー",
	"力強い",
	"息を含んだ",
];
export type MusicCreationOptions = {
	genreGroups: readonly { label: string; options: readonly string[] }[];
	moods: readonly string[];
	instruments: readonly string[];
	tempos: readonly string[];
	durations: readonly number[];
	vocalists: readonly string[];
	ranges: readonly string[];
	voiceQualities: readonly string[];
	singingStyles: readonly string[];
	languages: readonly string[];
	defaults: {
		tempo: string;
		duration: number;
		vocalist: string;
		range: string;
		singingStyle: string;
		language: string;
	};
};

/** Legacy saved views without registered choices keep their original form. */
export const defaultMusicCreationOptions: MusicCreationOptions = {
	genreGroups: musicGenres,
	moods: musicMoods,
	instruments: musicInstruments,
	tempos: ["おまかせ", "ゆったり", "中くらい", "速め"],
	durations: [10, 30, 60, 90, 120, 180, 300, 600],
	vocalists: ["おまかせ", "男性ボーカル", "女性ボーカル"],
	ranges: ["おまかせ", "低め", "中間", "高め"],
	voiceQualities: musicVoiceQualities,
	singingStyles: ["ソロ", "デュエット", "コーラス", "ラップ"],
	languages: ["日本語", "英語", "おまかせ"],
	defaults: {
		tempo: "おまかせ",
		duration: 30,
		vocalist: "おまかせ",
		range: "おまかせ",
		singingStyle: "ソロ",
		language: "日本語",
	},
};
export type MusicDurationModel = {
	task: "music" | "vocals" | "sound-effect";
	defaultDurationSeconds?: number;
	maxDurationSeconds: number;
};
export type MusicCreationInput = {
	task: "music" | "sound-effect";
	instrumental?: boolean;
	durationSeconds?: number;
	lyrics?: string;
};
export type MusicSelection = {
	genres: string[];
	moods: string[];
	instruments: string[];
	tempo: string;
	duration: string;
	soundEffect?: boolean;
	vocals: boolean;
	gender: string;
	range: string;
	voiceQualities: string[];
	singing: string;
	language: string;
	lyrics: string;
};
export const emptyMusicSelection = (
	options: MusicCreationOptions = defaultMusicCreationOptions,
): MusicSelection => ({
	genres: [],
	moods: [],
	instruments: [],
	tempo: options.defaults.tempo,
	duration: "",
	vocals: false,
	gender: options.defaults.vocalist,
	range: options.defaults.range,
	voiceQualities: [],
	singing: options.defaults.singingStyle,
	language: options.defaults.language,
	lyrics: "",
});
/** Serialize explicitly selected values only; the music worker interprets them. */
export function musicSelectionText(value: MusicSelection) {
	if (value.soundEffect)
		return [
			"用途：効果音",
			value.duration ? `長さ：${value.duration}秒` : "長さ：おまかせ",
		].join("\n");
	return [
		`用途：${value.vocals ? "ボーカル" : "歌なし音楽"}`,
		value.genres.length ? `ジャンル：${value.genres.join("、")}` : "",
		value.moods.length ? `雰囲気：${value.moods.join("、")}` : "",
		value.instruments.length ? `楽器：${value.instruments.join("、")}` : "",
		`テンポ：${value.tempo}`,
		value.duration ? `長さ：${value.duration}秒` : "長さ：おまかせ",
		`歌声：${value.vocals ? "あり" : "なし（インストゥルメンタル）"}`,
		...(value.vocals
			? [
					`ボーカル：${value.gender}`,
					`声の高さ：${value.range}`,
					value.voiceQualities.length
						? `声質：${value.voiceQualities.join("、")}`
						: "",
					`歌い方：${value.singing}`,
					`歌詞の言語：${value.language}`,
					value.lyrics
						? "歌詞：入力した歌詞を使用"
						: "歌詞：テーマに合わせて作成",
				]
			: []),
	]
		.filter(Boolean)
		.join("\n");
}

/** Only selected contract fields; hidden vocal data never enters a sound effect request. */
export function musicSelectionInput(value: MusicSelection): MusicCreationInput {
	return {
		task: value.soundEffect ? "sound-effect" : "music",
		...(!value.soundEffect ? { instrumental: !value.vocals } : {}),
		...(value.duration ? { durationSeconds: Number(value.duration) } : {}),
		...(value.vocals && !value.soundEffect && value.lyrics
			? { lyrics: value.lyrics }
			: {}),
	};
}
