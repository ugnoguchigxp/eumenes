import {
	defaultNotificationSound,
	type NotificationSound,
} from "../../../../api/domains/settings/contracts";

const assets = import.meta.glob<string>("./sounds/*.wav", {
	eager: true,
	query: "?url",
	import: "default",
});

/** Bundled audio only: notifications never invoke a generation service. */
export async function notificationSoundWav(
	choice: NotificationSound = defaultNotificationSound,
	signal: AbortSignal,
): Promise<Uint8Array | undefined> {
	signal.throwIfAborted();
	if (choice === "beep") return undefined;
	const url = assets[`./sounds/${choice}.wav`];
	if (!url) throw new Error("notification_sound_missing");
	const response = await fetch(url, { signal });
	if (!response.ok) throw new Error("notification_sound_unavailable");
	const bytes = new Uint8Array(await response.arrayBuffer());
	signal.throwIfAborted();
	if (
		bytes.length < 44 ||
		String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF" ||
		String.fromCharCode(...bytes.subarray(8, 12)) !== "WAVE"
	)
		throw new Error("notification_sound_invalid");
	return bytes;
}
