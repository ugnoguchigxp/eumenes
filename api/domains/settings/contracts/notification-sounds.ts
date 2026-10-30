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
