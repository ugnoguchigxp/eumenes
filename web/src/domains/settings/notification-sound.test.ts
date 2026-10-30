import { afterEach, expect, test, vi } from "vitest";
import { notificationSoundOptions } from "../../../../api/domains/settings/contracts";
import { notificationSoundWav } from "./notification-sound";
const timerToneWav = () => {
	const bytes = new Uint8Array(44);
	bytes.set(new TextEncoder().encode("RIFF"));
	bytes.set(new TextEncoder().encode("WAVE"), 8);
	return bytes;
};
afterEach(() => vi.unstubAllGlobals());
test("beep remains available offline and an aborted request cannot produce audio", async () => {
	const fetcher = vi.fn();
	vi.stubGlobal("fetch", fetcher);
	expect(
		await notificationSoundWav("beep", new AbortController().signal),
	).toBeUndefined();
	expect(fetcher).not.toHaveBeenCalled();
	const abort = new AbortController();
	abort.abort();
	await expect(
		notificationSoundWav("soft-chime", abort.signal),
	).rejects.toThrow();
});
test("the selected bundled WAV is loaded; HTTP failures and non-audio are rejected", async () => {
	const wav = timerToneWav();
	const fetcher = vi.fn(
		async (_url: string) => new Response(new Uint8Array(wav)),
	);
	vi.stubGlobal("fetch", fetcher);
	expect(
		await notificationSoundWav("glass-bell", new AbortController().signal),
	).toEqual(wav);
	expect(fetcher.mock.calls[0]?.[0]).toContain("glass-bell.wav");
	fetcher.mockImplementationOnce(
		async () => new Response("missing", { status: 404 }),
	);
	await expect(
		notificationSoundWav("soft-chime", new AbortController().signal),
	).rejects.toThrow("notification_sound_unavailable");
	fetcher.mockImplementationOnce(
		async () => new Response("<html>no audio</html>"),
	);
	await expect(
		notificationSoundWav("soft-chime", new AbortController().signal),
	).rejects.toThrow("notification_sound_invalid");
});
test("cancellation after download discards the late bytes", async () => {
	const abort = new AbortController();
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			abort.abort();
			return new Response(new Uint8Array(timerToneWav()));
		}),
	);
	await expect(
		notificationSoundWav("soft-chime", abort.signal),
	).rejects.toThrow();
});

test("all ten listening-approved assets can be fetched, including formerly retired choices", async () => {
	const fetcher = vi.fn(
		async (_url: string) => new Response(new Uint8Array(timerToneWav())),
	);
	vi.stubGlobal("fetch", fetcher);
	const sounds = notificationSoundOptions.filter(
		(option) => option.value !== "beep",
	);
	expect(sounds).toHaveLength(10);
	for (const sound of sounds) {
		expect(
			await notificationSoundWav(sound.value, new AbortController().signal),
		).toEqual(timerToneWav());
		expect(fetcher.mock.calls.at(-1)?.[0]).toContain(sound.value + ".wav");
	}
});
