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
	{ value: "soft-chime", label: "やわらかなチャイム" },
	{ value: "glass-bell", label: "澄んだベル" },
	{ value: "beep", label: "ビープ（従来の音）" },
] satisfies { value: NotificationSound; label: string }[];
