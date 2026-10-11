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
export type MusicSelection = {
	genres: string[];
	moods: string[];
	instruments: string[];
	tempo: string;
	duration: string;
	vocals: boolean;
	gender: string;
	range: string;
	voiceQualities: string[];
	singing: string;
	language: string;
	lyrics: string;
};
export const emptyMusicSelection = (): MusicSelection => ({
	genres: [],
	moods: [],
	instruments: [],
	tempo: "おまかせ",
	duration: "30",
	vocals: false,
	gender: "おまかせ",
	range: "おまかせ",
	voiceQualities: [],
	singing: "ソロ",
	language: "日本語",
	lyrics: "",
});
/** Serialize explicitly selected values only; the music worker interprets them. */
export function musicSelectionText(value: MusicSelection) {
	return [
		value.genres.length ? `ジャンル：${value.genres.join("、")}` : "",
		value.moods.length ? `雰囲気：${value.moods.join("、")}` : "",
		value.instruments.length ? `楽器：${value.instruments.join("、")}` : "",
		`テンポ：${value.tempo}`,
		`長さ：${value.duration}秒`,
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
						? `歌詞：\n${value.lyrics}`
						: "歌詞：テーマに合わせて作成",
				]
			: []),
	]
		.filter(Boolean)
		.join("\n");
}
