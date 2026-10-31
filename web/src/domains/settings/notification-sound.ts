import {
	defaultNotificationSound,
	type NotificationSound,
	type CompletionVoice,
} from "../../../../api/domains/settings/contracts";

const assets = import.meta.glob<string>("./sounds/*.wav", {
	eager: true,
	query: "?url",
	import: "default",
});

/** Notifications and completion voices share the same bundled audio validation. */
async function bundledWav(
	choice: string,
	signal: AbortSignal,
): Promise<Uint8Array> {
	signal.throwIfAborted();
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

/** Bundled audio only: notifications never invoke a generation service. */
export async function notificationSoundWav(
	choice: NotificationSound = defaultNotificationSound,
	signal: AbortSignal,
): Promise<Uint8Array | undefined> {
	signal.throwIfAborted();
	return choice === "beep" ? undefined : bundledWav(choice, signal);
}
export async function completionVoiceWav(
	choice: CompletionVoice = "none",
	signal: AbortSignal,
): Promise<Uint8Array | undefined> {
	signal.throwIfAborted();
	return choice === "none" ? undefined : bundledWav(choice, signal);
}
