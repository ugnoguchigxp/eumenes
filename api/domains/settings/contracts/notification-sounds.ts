/** Stable asset IDs shared by the settings contract and its registered picker. */
export const notificationSoundIds = [
	"soft-chime",
	"wooden-notes",
	"glass-bell",
	"water-drop",
	"warm-marimba",
	"tiny-harp",
	"felt-piano",
	"soft-sparkle",
	"bamboo",
	"gentle-bloom",
	"beep",
] as const;
export type NotificationSound = (typeof notificationSoundIds)[number];
export const defaultNotificationSound: NotificationSound = "soft-chime";
/** Only listening-approved assets are offered; legacy IDs remain readable above. */
export const notificationSoundOptions = [
	{
		value: "soft-chime",
		label: "やわらかなチャイム",
	},
	{
		value: "wooden-notes",
		label: "木琴の便り",
	},
	{
		value: "glass-bell",
		label: "澄んだベル",
	},
	{
		value: "water-drop",
		label: "水滴",
	},
	{
		value: "warm-marimba",
		label: "あたたかなマリンバ",
	},
	{
		value: "tiny-harp",
		label: "小さなハープ",
	},
	{
		value: "felt-piano",
		label: "やさしいピアノ",
	},
	{
		value: "soft-sparkle",
		label: "星のきらめき",
	},
	{
		value: "bamboo",
		label: "竹の響き",
	},
	{
		value: "gentle-bloom",
		label: "花ひらく音",
	},
	{
		value: "beep",
		label: "ビープ（従来の音）",
	},
] satisfies { value: NotificationSound; label: string }[];

export const completionVoiceIds = [
	"none",
	"task-completed-ja-male",
	"task-completed-en-male",
] as const;
export type CompletionVoice = (typeof completionVoiceIds)[number];
export const completionVoiceOptions = [
	{ value: "none", label: "音声なし" },
	{
		value: "task-completed-ja-male",
		label: "日本語・男性「タスクが完了しました」",
	},
	{
		value: "task-completed-en-male",
		label: "英語・男性「Task has been completed」",
	},
] satisfies { value: CompletionVoice; label: string }[];
